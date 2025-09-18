const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Post = require("../models/Post");
const ClusterAssignment = require("../models/ClusterAssignment");
const adminAuth = require("../middleware/adminAuth");
require("dotenv").config();

const router = express.Router();

// Admin login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    // Find user and check role
    const user = await User.findOne({ email, role: "admin" });
    if (!user) return res.status(400).json({ msg: "Admin not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    // Sign JWT with admin role
    const token = jwt.sign(
      { id: user._id, role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "1y" }
    );

    res.json({
      token,
      admin: { id: user._id, username: user.username, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
    console.log(err);

  }
});

// Protected admin route example
router.get("/me", adminAuth, async (req, res) => {
  try {
    const admin = await User.findById(req.admin.id).select("-password");
    res.json(admin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔄 Admin: Get deduplicated/clustered posts (always return cluster for testing + set InProgress)
router.get("/posts/deduplicate", adminAuth, async (req, res) => {
  try {
    const posts = await Post.find()
      .populate("user", "username email")
      .sort({ createdAt: -1 })
      .lean();

    // --- helpers ---
    const getDescriptionSimilarity = (desc1, desc2) => {
      const words1 = (desc1 || "").toLowerCase().split(/\W+/);
      const words2 = (desc2 || "").toLowerCase().split(/\W+/);
      const overlap = words1.filter(word => words2.includes(word)).length;
      return overlap / Math.max(words1.length, words2.length || 1);
    };

    const getDistance = (coords1, coords2) => {
      if (!coords1 || !coords2) return Infinity;
      const [lon1, lat1] = coords1;
      const [lon2, lat2] = coords2;
      if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;

      const R = 6371e3;
      const φ1 = lat1 * Math.PI/180;
      const φ2 = lat2 * Math.PI/180;
      const Δφ = (lat2-lat1) * Math.PI/180;
      const Δλ = (lon2-lon1) * Math.PI/180;

      const a = Math.sin(Δφ/2) ** 2 +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    const recommendDepartment = (description) => {
      const keywords = {
        'roads': ['road', 'pothole', 'street', 'footpath', 'traffic', 'bridge', 'construction'],
        'water': ['water', 'pipe', 'leak', 'drainage', 'sewage', 'flood'],
        'waste': ['garbage', 'waste', 'trash', 'dump', 'cleaning', 'sanitation'],
        'electricity': ['light', 'electricity', 'power', 'streetlight', 'electric', 'wire'],
        'parks': ['park', 'garden', 'tree', 'playground', 'grass', 'recreation']
      };

      const descLower = (description || "").toLowerCase();
      let maxMatches = 0;
      let recommendedDept = 'roads';

      for (const [dept, words] of Object.entries(keywords)) {
        const matches = words.filter(word => descLower.includes(word)).length;
        if (matches > maxMatches) {
          maxMatches = matches;
          recommendedDept = dept;
        }
      }
      return recommendedDept;
    };

    // --- clustering ---
    const clusters = [];
    const processedPosts = new Set();

    for (const post of posts) {
      if (processedPosts.has(post._id.toString())) continue;

      const cluster = {
        mainPost: post,
        issues: [post],
        recommendedDepartment: recommendDepartment(post.description || '')
      };

      for (const otherPost of posts) {
        if (post._id === otherPost._id || processedPosts.has(otherPost._id.toString())) continue;

        const descSim = getDescriptionSimilarity(post.description, otherPost.description);
        const distance = getDistance(post.location?.coordinates, otherPost.location?.coordinates);
        const timeDiff = Math.abs(new Date(post.createdAt) - new Date(otherPost.createdAt)) / (1000*60*60);

        if (descSim > 0.5 && distance < 1000 && timeDiff < 24) {
          cluster.issues.push(otherPost);
          processedPosts.add(otherPost._id.toString());
        }
      }

      if (cluster.issues.length > 1) {
        processedPosts.add(post._id.toString());
        clusters.push(cluster);
      }
    }

    // --- if no real cluster, add dummy ---
    if (clusters.length === 0) {
      clusters.push({
        mainPost: {
          _id: "dummy_main",
          description: "Road damaged near main street",
          location: { type: "Point", coordinates: [80.123, 13.456] },
          createdAt: new Date(),
        },
        recommendedDepartment: "roads",
        issues: [
          {
            _id: "dummy_issue1",
            description: "Huge pothole near bus stop",
            location: { type: "Point", coordinates: [80.123, 13.456] },
            address: "Main Street",
            createdAt: new Date(),
            user: { username: "TestUser" },
            status: "InProgress"
          }
        ]
      });
    } else {
      // ✅ update status of real clustered posts to "InProgress"
      const issueIds = clusters.flatMap(c => c.issues.map(i => i._id));
      await Post.updateMany(
        { _id: { $in: issueIds } },
        { $set: { status: "InProgress", updatedAt: new Date() } }
      );
      // reflect change in response
      clusters.forEach(c => c.issues.forEach(i => i.status = "InProgress"));
    }

    res.json({
      success: true,
      msg: "Clusters (with InProgress status for testing)",
      clusters: clusters.map(cluster => ({
        mainPost: {
          id: cluster.mainPost._id,
          description: cluster.mainPost.description,
          location: cluster.mainPost.location,
          createdAt: cluster.mainPost.createdAt
        },
        recommendedDepartment: cluster.recommendedDepartment,
        issues: cluster.issues.map(issue => ({
          id: issue._id,
          description: issue.description,
          location: issue.location,
          address: issue.address,
          createdAt: issue.createdAt,
          userName: issue.user?.username || "Anonymous",
          status: issue.status || "InProgress",
          latitude: issue.location?.coordinates?.[1] || null,
          longitude: issue.location?.coordinates?.[0] || null,
          media: issue.media || [],
          voiceMsg: issue.voiceMsg || null
        }))
      })),
      totalIssues: clusters.reduce((acc, c) => acc + c.issues.length, 0)
    });

  } catch (err) {
    console.error("❌ Error duplicatess posts:", err);
    res.status(500).json({ error: err.message });
  }
});

// Handle cluster acknowledgment and department assignment
router.post("/posts/acknowledge-cluster", adminAuth, async (req, res) => {
  try {
    const { clusterId, issues, adminComment, department, status } = req.body;

    // Create new cluster assignment
    const clusterAssignment = new ClusterAssignment({
      clusterId,
      issues,
      department,
      adminComment,
      status,
      acknowledgedBy: req.admin.id,
      departmentUpdates: [{
        status: 'Received',
        comment: 'Issue forwarded to department'
      }]
    });

    // Save the cluster assignment
    await clusterAssignment.save();

    // Update all issues in the cluster with reference to the assignment
    await Post.updateMany(
      { _id: { $in: issues } },
      { 
        $set: { 
          status: status,
          clusterAssignment: clusterAssignment._id, // Reference to the assignment
          updatedAt: new Date()
        } 
      }
    );

    res.json({ 
      msg: "Cluster acknowledged and forwarded to department",
      department,
      updatedIssues: issues.length,
      clusterAssignmentId: clusterAssignment._id
    });
  } catch (err) {
    console.error("❌ Error acknowledging cluster:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all admin posts
router.get("/posts/all", adminAuth, async (req, res) => {
  try {
    const posts = await Post.find()
      .populate("user", "username email")
      .populate("clusterAssignment")
      .sort({ createdAt: -1 })
      .lean();

    // Flatten user object for easier frontend handling
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

// Get cluster assignment details
router.get("/cluster-assignments/:id", adminAuth, async (req, res) => {
  try {
    const assignment = await ClusterAssignment.findById(req.params.id)
      .populate("issues")
      .populate("acknowledgedBy", "username email")
      .lean();

    if (!assignment) {
      return res.status(404).json({ msg: "Cluster assignment not found" });
    }

    res.json(assignment);
  } catch (err) {
    console.error("❌ Error fetching cluster assignment:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update cluster assignment status
router.patch("/cluster-assignments/:id", adminAuth, async (req, res) => {
  try {
    const { status, comment } = req.body;
    const assignment = await ClusterAssignment.findById(req.params.id);

    if (!assignment) {
      return res.status(404).json({ msg: "Cluster assignment not found" });
    }

    // Add new update to department updates
    assignment.departmentUpdates.push({
      status,
      comment,
      updatedAt: new Date()
    });

    // If status is 'Completed', update the main status to 'Resolved'
    if (status === 'Completed') {
      assignment.status = 'Resolved';
      // Update all associated posts
      await Post.updateMany(
        { _id: { $in: assignment.issues } },
        { $set: { status: 'Resolved' } }
      );
    }

    await assignment.save();

    res.json(assignment);
  } catch (err) {
    console.error("❌ Error updating cluster assignment:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;