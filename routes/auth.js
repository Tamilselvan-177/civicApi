const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const User = require("../models/User");
const DeviceToken = require("../models/DeviceToken"); // <-- Add this
const auth = require("../middleware/auth");
require("dotenv").config();

const router = express.Router();

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS }
});

// Register
router.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ msg: "User already exists" });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const verificationToken = crypto.randomBytes(32).toString("hex");

    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      verificationToken
    });
    await newUser.save();

    const mailOptions = {
      from: process.env.EMAIL,
      to: email,
      subject: "Verify your Civic Account",
      html: `<p>Hello ${username},</p>
             <p>Click the link below to verify your account:</p>
             <a href="${process.env.CLIENT_URL}/api/auth/verify/${verificationToken}">Verify Email</a>`
    };

    await transporter.sendMail(mailOptions);

    res.json({ msg: "Registration successful! Please check your email to verify your account." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify email link
router.get("/verify/:token", async (req, res) => {
  try {
    const user = await User.findOne({ verificationToken: req.params.token });
    if (!user) return res.status(400).json({ msg: "Invalid or expired token" });

    user.isVerified = true;
    user.verificationToken = null;
    await user.save();

    res.json({ msg: "Email verified successfully! You can now log in." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "User does not exist" });

    if (!user.isVerified) return res.status(401).json({ msg: "Please verify your email first" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "1y" });

    res.json({
      token,
      user: { id: user._id, username: user.username, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
  console.log("Login route accessed");
});

// Protected route
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔔 Register Expo push token (authenticated users only)
router.post("/register-token", async (req, res) => {
  try {
    const userId = req.user.id; // get from auth middleware
    const { token } = req.body;

    if (!token) return res.status(400).json({ msg: "Push token is required" });

    // Upsert token
    await DeviceToken.findOneAndUpdate(
      { userId, token },
      { userId, token },
      { upsert: true }
    );

    res.json({ msg: "Push token registered successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
