const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");

const postRoutes = require("./routes/post");
const profileRoutes = require("./routes/profile");
const authRoutes = require("./routes/auth");

const app = express();

app.use(express.json());
app.use(cors());


// ✅ Create a write stream (in append mode) for logs
const accessLogStream = fs.createWriteStream(
  path.join(__dirname, "access.log"),
  { flags: "a" }
);

// ✅ Morgan setup
app.use(morgan("dev")); // logs to console
app.use(morgan("combined", { stream: accessLogStream })); // logs to file

// MongoDB connection
mongoose
  .connect("mongodb://127.0.0.1:27017/civic")
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log(err));

// Routes
app.use("/api/posts", postRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
