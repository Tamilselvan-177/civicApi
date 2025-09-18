const mongoose = require("mongoose");
const Comment = require("./Comment");
const Like = require("./Like");

const postSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  description: { type: String },
  voiceMsg: { type: String }, // path to uploaded voice file
  media: [{ type: String }],  // image/video file paths
  location: {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point"
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true
    }
  }
}, { timestamps: true });

// Cascade delete comments and likes when a post is deleted
postSchema.pre("findOneAndDelete", async function(next) {
  const postId = this.getQuery()["_id"];
  await Comment.deleteMany({ post: postId });
  await Like.deleteMany({ post: postId });
  next();
});

module.exports = mongoose.model("Post", postSchema);
