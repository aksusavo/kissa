const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Kissakoira API toimii!");
});

app.get("/api/test", (req, res) => {
    res.json({
        status: "ok",
        message: "API-yhteys toimii!"
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});