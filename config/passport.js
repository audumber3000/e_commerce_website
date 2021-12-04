const passport = require("passport");
const LocalStrategy = require("passport-local").Strategy;
const User = require("../models/user");
var nodemailer = require('nodemailer');


//sending mail to new user
var transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'audumberchaudhari3000@gmail.com',
    pass: 'Audumber@3000'
  }
});





passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  User.findById(id, (err, user) => {
    done(err, user);
  });
});

passport.use(
  "local.signup",
  new LocalStrategy(
    {
      usernameField: "email",
      passwordField: "password",
      passReqToCallback: true,
    },
    async (req, email, password, done) => {
      try {
        const user = await User.findOne({ email: email });


        //from where and what mail
var mailOptions = {
  from: 'audumberchaudhari3000@gmail.com',
  to: email,
  subject: 'Thank you for signing up! ',
  text: 'Hi ' +user   +'\n We are glad that you have joined Adnate IOT  .It seems that yet you have not started you shopping with Us. We regularly share all the best offers available on our plateform. \n\n keep Shopping !'
}


       

        if (user) {
          return done(null, false, { message: "Email already exists" });
        }
        if (password != req.body.password2) {
          return done(null, false, { message: "Passwords must match" });
        }
        const newUser = await new User();
        newUser.email = email;
        newUser.password = newUser.encryptPassword(password);
        newUser.username = req.body.name;
        await newUser.save();

        //sending mail
        transporter.sendMail(mailOptions, function(error, info){
          if (error) {
            console.log(error);
            return done(null, false, { message: "Email is invalid" });
          } else {
            console.log('Email sent: ' + info.response);
            return done(null, newUser);
          }
        });


      } catch (error) {
        console.log(error);
        return done(error);
      }
    }
  )
);

passport.use(
  "local.signin",
  new LocalStrategy(
    {
      usernameField: "email",
      passwordField: "password",
      passReqToCallback: false,
    },
    async (email, password, done) => {
      try {
        const user = await User.findOne({ email: email });
        if (!user) {
          return done(null, false, { message: "User doesn't exist" });
        }
        if (!user.validPassword(password)) {
          return done(null, false, { message: "Wrong password" });
        }
        return done(null, user);
      } catch (error) {
        console.log(error);
        return done(error);
      }
    }
  )
);
