const mongoose = require("mongoose");
const Post = require("./models/Post"); // Adjust path if needed
const User = require("./models/User");
const { faker } = require("@faker-js/faker");

const MONGO_URI = "mongodb://127.0.0.1:27017/civic"; // change if needed
const IMAGE_PATH = "uploads/1758376340134.jpg"; // your fixed image

mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error(err));

async function seedPosts() {
  try {
    const users = await User.find(); // Use existing users
    if (users.length === 0) {
      console.log("No users found. Create some users first!");
      return;
    }

    const posts = [];
    for (let i = 0; i < 1000; i++) {
      const randomUser = users[Math.floor(Math.random() * users.length)];
      const post = {
        user: randomUser._id,
        description: faker.lorem.sentence(),
        media: [IMAGE_PATH],
        location: {
          type: "Point",
          coordinates: [
            parseFloat(faker.address.longitude()),
            parseFloat(faker.address.latitude())
          ]
        },
        address: faker.address.streetAddress(),
        status: faker.helpers.arrayElement(["Pending", "In Progress", "Resolved"])
      };
      posts.push(post);

      if (i % 1000 === 0) console.log(`${i} posts prepared`);
    }

    await Post.insertMany(posts);
    console.log("10000 posts inserted successfully!");
    mongoose.disconnect();
  } catch (err) {
    console.error(err);
  }
}

seedPosts();
