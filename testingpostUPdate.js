const mongoose = require("mongoose");
const Post = require("./models/Post"); // Adjust path if needed
const { faker } = require("@faker-js/faker");

const MONGO_URI = "mongodb://127.0.0.1:27017/civic"; // change if needed

// Array of sample civic problems
const civicProblems = [
  "Pothole on Main Street",
  "Streetlight not working near Park Avenue",
  "Overflowing garbage bin on 5th Street",
  "Water leakage near City Hall",
  "Damaged sidewalk near School Road",
  "Traffic signal malfunction at Crossroad Junction",
  "Graffiti on public walls",
  "Fallen tree blocking road",
  "Open manhole on Elm Street",
  "Illegal dumping near river"
];

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected ✅"))
  .catch(err => console.error("MongoDB connection error:", err));

async function updateDescriptions() {
  try {
    const posts = await Post.find();

    if (!posts.length) {
      console.log("No posts found to update.");
      process.exit(0);
    }

    for (const post of posts) {
      const randomProblem = civicProblems[Math.floor(Math.random() * civicProblems.length)];
      post.description = randomProblem;
      await post.save();
    }

    console.log(`Updated description for ${posts.length} posts ✅`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

updateDescriptions();
