/*
 * Frontoffice sub-app for quiz running.
 */

var fs              = require('fs');
var passport        = require('passport');
var path            = require('path');
var TwitterStrategy = require('passport-twitter').Strategy;
var Sequelize       = require('sequelize');
var Quiz            = require('../models/quiz');
var engine          = require('../engine');
var _               = require('underscore');
var io              = require('socket.io');
var localIP         = require('../client/local_ip').localIP;

module.exports = frontOfficeApp;

var OAUTH_CALLBACK_PATH = '/ohai';

// Subapp setup
// ============

function frontOfficeApp(app, mode, server) {
  if ('routes' !== mode) {
    bindWebSockets(server);

    // Subapp-local views
    app.use('/front', function useLocalViews(req, res, next) {
      app.set('views', path.join(__dirname, 'views'));
      next();
    });
  }

  if ('middleware' !== mode) {
    // Root access should redirect to the frontoffice subapp
    app.all('/', function(req, res) {
      res.redirect(301, '/front');
    });

    // Namespaced quiz running routes
    app.namespace('/front', function() {
      app.get('/', mainPage);

      app.get('/auth', passport.authenticate('twitter'));

      app.get(OAUTH_CALLBACK_PATH, passport.authenticate('twitter', {
        successRedirect: '/front',
        failureFlash: true,
        failureRedirect: '/front'
      }));
    });
  }
}

function mainPage(req, res) {
  engine.checkAuth(req, res, function() {
    if (engine.currentQuiz) {
      engine.getUsers(function(err, users) {
        if (err) throw err;
        res.render('index', { user: req.user, engine: engine, users: users });
      });
    } else {
      res.render('index', { user: req.user, engine: engine });
    }
  });
}

// WebSockets manager
// ==================

// This binds a WebSockets layer over the HTTP app and provides the gateway
// between WS traffic and the engine (both ways).

function bindWebSockets(server) {
  var sio = io.listen(server);
  sio.set('log level', 2);

  function justForward(call) {
    engine.on(call, function() {
      sio.sockets.emit.apply(sio.sockets, _.flatten([call, arguments]));
    });
  }

  // Quiz init: notify waiting clients ("No active quiz yet…" front screens)
  engine.on('quiz-init', function(quiz) {
    engine.getUsers(function(err, users) {
      if (err) throw err;
      sio.sockets.emit('quiz-init', _.pick(quiz, 'title', 'description', 'level'), users);
    });
  });

  // Quiz join: a new user comes in the engine while a quiz is at init stage.
  justForward('quiz-join');

  // Question start: a new question starts! (including quiz start)
  justForward('question-start');

  // Answers coming in (input)
  sio.sockets.on('connection', function(socket) {
    socket.on('answer', function(answer) {
      socket.set('userId', answer.userId);
      engine.handleAnswer(answer);
    });
  });

  // Answers getting in (output)
  justForward('new-answer');
  justForward('edit-answer');

  // Question ends!
  justForward('question-end');

  // Quiz ends!
  engine.on('quiz-end', function(scoreboard) {
    // For every socket, check whether it's a player, and if so get and send their scoring.
    sio.sockets.clients().forEach(function(socket) {
      socket.get('userId', function(err, userId) {
        var scoring = userId && _.findWhere(scoreboard, { id: userId });
        if (scoring) {
          scoring.rank = scoreboard.indexOf(scoring) + 1;
        }
        socket.emit('quiz-end', scoring);
      });
    });
  });
}

// Frontoffice authentication setup
// ================================

// Read credentials off a JSON file
// in this file's directory and initialize a Passport Twitter OAuth strategy
// with those.

function readCredentials(cb) {
  fs.readFile(path.join(__dirname, 'credentials.json'), function(err, json) {
    if (err)
      console.warn("Missing frontoffice credentials -> You won't be able to authenticate!");

    var creds = JSON.parse(json || '{}');
    if (creds.consumerKey && creds.consumerSecret)
      console.log("Front credentials loaded");
    else
      console.log("One or more blank front credential -> You won't be able to authenticate!");

    cb(creds);
  });
}

readCredentials(function(creds) {
  console.log('OAuth callback IP', localIP);

  passport.use(new TwitterStrategy(
    _.extend(creds, { callbackURL: 'http://' + localIP + ':3000/front' + OAUTH_CALLBACK_PATH }),
    function(token, tokenSecret, profile, done) {
      var user = {
        id: profile.id,
        name: '@' + profile.displayName,
        avatar: (profile.photos[0] || {}).value
      };
      console.log('TWITTER USER: ', user);
      done(null, user);
    }
  ));

  passport.serializeUser(function(user, done) {
    // Everything for now, but when deserialize looks it up in Redis, id only.
    done(null, user);
  });

  passport.deserializeUser(function(user, done) {
    // Nothing for now, but when we look it up in Redis, we'll get the id only.
    done(null, user);
  });
});