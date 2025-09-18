const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isVerified: { type: Boolean, default: false },  // new
  verificationToken: { type: String }    , // new
  role: { type: String, enum: ["user", "admin"], default: "user" }, // <-- add this line

    name: { type: String },
  age: { type: Number },
  dob: { type: Date },
  phone: { type: String },
 bio: { type: String },           // short description about user
  profilePic: { type: String }, 

}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
    