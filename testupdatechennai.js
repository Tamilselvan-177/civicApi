const mongoose = require("mongoose");
const Post = require("./models/Post"); // Adjust path if needed

const MONGO_URI = "mongodb://127.0.0.1:27017/civic"; // change if needed

// Chennai center coordinates
const CHENNAI_LAT = 13.0827;
const CHENNAI_LNG = 80.2707;

// Radius in km
const RADIUS_KM = 1;

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected ✅"))
  .catch(err => console.error("MongoDB connection error:", err));

async function updateChennaiPosts() {
  try {
    const result = await Post.updateMany(
      {
        location: {
          $geoWithin: {
            $centerSphere: [[CHENNAI_LNG, CHENNAI_LAT], RADIUS_KM / 6371] // radius in radians (Earth radius ≈ 6371 km)
          }
        }
      },
      { $set: { status: "Pending" } }
    );

    console.log(`✅ Updated ${result.modifiedCount} posts in Chennai to Pending`);
    process.exit(0);
  } catch (err) {
    console.error("Error updating posts:", err);
    process.exit(1);
  }
}

updateChennaiPosts();
