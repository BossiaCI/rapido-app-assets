const express = require("express");
const router = express.Router();
const { refreshToken, auth } = require("../controllers/auth");

router.post("/refresh-token", refreshToken);
router.post("/signin", auth);

module.exports = router;
