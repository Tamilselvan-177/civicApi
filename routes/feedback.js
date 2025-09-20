// const express = require("express");
// const ClusterAssignment = require("../models/ClusterAssignment");
// const Post = require("../models/Post");
// const auth = require("../middleware/auth");

// const router = express.Router();

// /**
//  * Submit feedback using Post ID in URL
//  * Example: POST /api/feedback/submit/68ca7c1034b96ab7c5d13ae2
//  * Body: { "rating": 5, "comment": "Great work" }
//  */
// router.post("/submit/:id", auth, async (req, res) => {
//   try {
//     const postId = req.params.id;
//     const { rating, comment } = req.body;

//     // Validation
//     if (!rating || rating < 1 || rating > 5) {
//       return res.status(400).json({
//         success: false,
//         msg: "Rating is required and must be between 1 and 5"
//       });
//     }

//     if (!comment || comment.trim().length < 5) {
//       return res.status(400).json({
//         success: false,
//         msg: "Comment is required and must be at least 5 characters long"
//       });
//     }

//     // Check if post exists
//     const post = await Post.findById(postId);
//     if (!post) {
//       return res.status(404).json({
//         success: false,
//         msg: "Post not found"
//       });
//     }

//     // Find cluster assignment that contains this post
//     const assignment = await ClusterAssignment.findOne({ issues: postId });
//     if (!assignment) {
//       return res.status(405).json({
//         success: false,
//         msg: "No cluster assignment found for this post. The issue may not have been processed yet."
//       });
//     }

//     // Check if assignment is resolved
//     if (assignment.status !== "Resolved") {
//       return res.status(400).json({
//         success: false,
//         msg: "You can only provide feedback after the issue has been resolved"
//       });
//     }

//     // Check if user already submitted feedback for this post
//     const existingFeedback = assignment.citizenFeedback.find(
//       (feedback) => feedback.postId && feedback.postId.toString() === postId
//     );

//     if (existingFeedback) {
//       return res.status(400).json({
//         success: false,
//         msg: "You have already submitted feedback for this issue"
//       });
//     }

//     // Add feedback
//     const feedbackData = {
//       postId,
//       rating: parseInt(rating),
//       comment: comment.trim(),
//       submittedAt: new Date()
//     };

//     assignment.citizenFeedback.push(feedbackData);

//     // Recalculate average rating
//     const avgRating =
//       assignment.citizenFeedback.reduce((sum, f) => sum + f.rating, 0) /
//       assignment.citizenFeedback.length;

//     if (!assignment.metrics) {
//       assignment.metrics = {};
//     }
//     assignment.metrics.citizenSatisfactionScore = (avgRating / 5) * 10; // 0–10 scale

//     await assignment.save();

//     res.json({
//       success: true,
//       msg: "Feedback submitted successfully",
//       data: {
//         postId,
//         assignmentId: assignment._id,
//         clusterId: assignment.clusterId,
//         department: assignment.department,
//         yourRating: rating,
//         yourComment: comment,
//         averageRating: avgRating.toFixed(1),
//         totalFeedbacks: assignment.citizenFeedback.length
//       }
//     });
//   } catch (err) {
//     console.error("Error submitting feedback:", err);
//     res.status(500).json({
//       success: false,
//       error: "Server error while submitting feedback",
//       msg: err.message
//     });
//   }
// });

// module.exports = router;
const express = require("express");
const auth = require("../middleware/auth");
const Post = require("../models/Post");

const router = express.Router();

// Submit feedback for a post
router.post("/submit/:id", auth, async (req, res) => {
  try {
    const postId = req.params.id;
    const { rating, comment } = req.body;

    // Validation
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        msg: "Rating is required and must be between 1 and 5"
      });
    }

    if (!comment || comment.trim().length < 5) {
      return res.status(400).json({
        success: false,
        msg: "Comment is required and must be at least 5 characters long"
      });
    }

    // Check if post exists
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({
        success: false,
        msg: "Post not found"
      });
    }

    // Initialize feedback array if it doesn't exist
    if (!post.feedback) post.feedback = [];

    // Check if user already submitted feedback
    const existingFeedback = post.feedback.find(
      f => f.userId && f.userId.toString() === req.user.id
    );

    if (existingFeedback) {
      return res.status(400).json({
        success: false,
        msg: "You have already submitted feedback for this post"
      });
    }

    // Add feedback
    const feedbackData = {
      userId: req.user.id,
      rating: parseInt(rating),
      comment: comment.trim(),
      submittedAt: new Date()
    };

    post.feedback.push(feedbackData);

    // Recalculate average rating
    const avgRating = post.feedback.reduce((sum, f) => sum + f.rating, 0) / post.feedback.length;
    post.avgRating = avgRating;

    await post.save();

    res.json({
      success: true,
      msg: "Feedback submitted successfully",
      data: {
        postId,
        yourRating: rating,
        yourComment: comment,
        averageRating: avgRating.toFixed(1),
        totalFeedbacks: post.feedback.length
      }
    });
  } catch (err) {
    console.error("Error submitting feedback:", err);
    res.status(500).json({
      success: false,
      error: "Server error while submitting feedback",
      msg: err.message
    });
  }
});

module.exports = router;
