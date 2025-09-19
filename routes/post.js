const express = require("express");
const auth = require("../middleware/auth");
const upload = require("../middleware/upload");
const Post = require("../models/Post");
const Like = require("../models/Like");
const Comment = require("../models/Comment");

const router = express.Router();
// ✅ Create a post API
router.post(
  "/",
  auth,
  upload.fields([
    { name: "media", maxCount: 5 },   // images/videos
    { name: "voiceMsg", maxCount: 1 } // voice message
  ]),
  async (req, res) => {
    try {
      // ✅ Extract text fields (from FormData)
      const description = req.body.description || "";
      const latitude = parseFloat(req.body.latitude);
      const longitude = parseFloat(req.body.longitude);

      // ✅ Extract files safely
      const mediaFiles = req.files && req.files.media ? req.files.media.map(f => f.path) : [];
      const voiceFile = req.files && req.files.voiceMsg ? req.files.voiceMsg[0].path : null;

      // ✅ Validation rules
      if (!description && !voiceFile) {
        return res.status(400).json({ msg: "Either description or voice message is required" });
      }

      if (mediaFiles.length === 0) {
        return res.status(400).json({ msg: "At least one media file (image/video) is required" });
      }

      // ✅ Create post
      const newPost = new Post({
        user: req.user.id,
        description,
        voiceMsg: voiceFile,
        media: mediaFiles,
        location: {
          type: "Point",
          coordinates: [longitude, latitude]
        }
      });

      await newPost.save();

      return res.status(201).json({
        msg: "Post created successfully ✅",
        post: newPost
      });
    } catch (err) {
      console.error("❌ Error creating post:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// Get all posts
router.get("/", auth, async (req, res) => {
  try {
    const posts = await Post.find().populate("user", "username email");
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// 🔍 Search posts
router.get("/search", auth, async (req, res) => {
  try {
    const { q } = req.query; // search keyword

    if (!q || q.trim() === "") {
      return res.status(400).json({ msg: "Search query is required" });
    }

    // Search in description or user (username/email)
    const posts = await Post.find({
      $or: [
        { description: { $regex: q, $options: "i" } } // case-insensitive
      ]
    })
      .populate("user", "username email")
      .sort({ createdAt: -1 });

    if (!posts || posts.length === 0) {
      return res.status(404).json({ msg: "No posts found matching your search" });
    }

    res.json({ msg: "Search results", posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ✅ Get posts with pagination + likes & comments count
router.get("/paginated", auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    // Fetch paginated posts
    const posts = await Post.find()
      .populate("user", "username email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Add likesCount, commentsCount, and isLikedByUser for each post
    const postsWithCounts = await Promise.all(
      posts.map(async (post) => {
        const likes = await Like.find({ post: post._id });
        const comments = await Comment.find({ post: post._id });
        const isLikedByUser = likes.some(like => like.user.toString() === req.user.id);

        return {
          ...post.toObject(),
          likesCount: likes.length,
          commentsCount: comments.length,
          isLikedByUser
        };
      })
    );

    const totalPosts = await Post.countDocuments();

    res.json({
      msg: "Posts fetched successfully ✅",
      page,
      totalPages: Math.ceil(totalPosts / limit),
      totalPosts,
      posts: postsWithCounts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/my/posts", auth, async (req, res) => {
  try {
    const posts = await Post.find({ user: req.user.id })
      .populate("user", "username email")
      .sort({ createdAt: -1 });

    if (!posts || posts.length === 0) {
      return res.status(404).json({ msg: "You haven’t created any posts yet" });
    }

    res.json({ msg: "Your posts", posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//  auth, <>><<><><><><><><><><><><><><><><>
// 📊 Get counts of posts by status and total reports
router.get("/stats", async (req, res) => {
  try {
    const resolvedCount = await Post.countDocuments({ status: "Resolved" });
    const pendingCount = await Post.countDocuments({ status: "Pending" });
    const inProgressCount = await Post.countDocuments({ status: "In Progress" });
    console.log("Resolved Count:", resolvedCount);
    console.log("Pending Count:", pendingCount);
    console.log("InProgress Count:", inProgressCount);
    const totalReports = await Post.countDocuments();

    res.json({
      resolved: resolvedCount,
      pending: pendingCount,
      inProgress: inProgressCount,
      totalReports
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/// 📓📓📓📓
// 🛡️ Admin: Get all posts with location and description (no auth)
// routes/admin.js
router.get("/admin/all", async (req, res) => {
  try {
    const posts = await Post.find({}, { location: 1, description: 1, status: 1, createdAt: 1 })
      .populate("user", "username email")
      .lean(); // faster, returns plain JS objects

    res.json(posts); // 👈 send array directly, not wrapped { posts }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🛡️ Admin: Get all posts (flattened for dashboard)
router.get("/admin/posts", async (req, res) => {
  try {
    const posts = await Post.find()
      .populate("user", "username email")
      .sort({ createdAt: -1 })
      .lean();

    // flatten user object
    const formattedPosts = posts.map((post) => ({
      ...post,
      userId: post.user?._id || null,
      userName: post.user?.username || "Unknown",
      userEmail: post.user?.email || "",
    }));

    res.json(formattedPosts);
  } catch (err) {
    console.error("❌ Error fetching admin posts:", err);
    res.status(500).json({ error: err.message });
  }
});









//// #### users

// ✏️ Update a post (only owner, only within 5 minutes)
router.put("/:id", auth, async (req, res) => {
  try {
    const postId = req.params.id;
    const { description } = req.body;

    // Find the post
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ msg: "Post not found" });

    // Check ownership
    if (post.user.toString() !== req.user.id) {
      return res.status(403).json({ msg: "You are not authorized to edit this post" });
    }

    // Check 5-minute edit window
    const now = new Date();
    const diffMinutes = (now - post.createdAt) / 1000 / 60;
    if (diffMinutes > 5) {
      return res.status(400).json({ msg: "You can only edit a post within 5 minutes of creation" });
    }

    // Update description
    if (description) post.description = description;
    post.updatedAt = Date.now();

    await post.save();
    res.json({ msg: "Post updated successfully ✅", post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id", auth, async (req, res) => {
  try {
    const postId = req.params.id;

    const post = await Post.findById(postId).populate("user", "username email");
    if (!post) return res.status(404).json({ msg: "Post not found" });

    const likes = await Like.find({ post: postId }).populate("user", "username email");
    const comments = await Comment.find({ post: postId })
      .populate("user", "username email")
      .sort({ createdAt: -1 });

    const isLikedByUser = likes.some(like => like.user._id.toString() === req.user.id);

    res.json({
      post,
      likesCount: likes.length,
      commentsCount: comments.length,
      isLikedByUser,
      likes,
      comments
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// 📥 Get all comments for a post
router.get("/:id/comments", auth, async (req, res) => {
  try {
    const postId = req.params.id;

    const comments = await Comment.find({ post: postId })
      .populate("user", "username email")
      .sort({ createdAt: -1 });

    res.json({ 
      msg: "Comments fetched successfully ✅", 
      count: comments.length, 
      comments 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


//✅ Like/Unlike Post
// Like or Unlike a post
router.post("/:id/like", auth, async (req, res) => {
  try {
    const postId = req.params.id;

    const existingLike = await Like.findOne({ user: req.user.id, post: postId });

    if (existingLike) {
      // Unlike
      await Like.findByIdAndDelete(existingLike._id);
      return res.json({ msg: "Post unliked" });
    } else {
      // Like
      const like = new Like({ user: req.user.id, post: postId });
      await like.save();
      return res.json({ msg: "Post liked" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🏪Add a comment to a post
router.post("/:id/comment", auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ msg: "Comment text is required" });

    const comment = new Comment({
      user: req.user.id,
      post: req.params.id,
      text
    });

    await comment.save();
    res.json({ msg: "Comment added", comment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
