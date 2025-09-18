const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");

const postRoutes = require("./routes/post");
const profileRoutes = require("./routes/profile");
const authRoutes = require("./routes/auth");
const adminAuthRoutes = require("./routes/adminAuth"); // Add this line
const ivrRoutes = require('./routes/ivr');

const app = express();

app.use(express.json());
app.use(cors({ origin: true, credentials: true }));


// ✅ Create a write stream (in append mode) for logs
const accessLogStream = fs.createWriteStream(
  path.join(__dirname, "access.log"),
  { flags: "a" }
);

// ✅ Morgan setup
app.use(morgan("dev")); // logs to console
app.use(morgan("combined", { stream: accessLogStream })); // logs to file
app.use(express.urlencoded({ extended: true }));

// MongoDB connection

//mongodb+srv://Tamil:<db_password>@cluster0.j3m9g.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log(err));

// Routes
app.use("/api/posts", postRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/admin", adminAuthRoutes);
app.use('/api/ivr', ivrRoutes);

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
