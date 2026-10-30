
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({
    origin: [
        "https://kissakoira.xyz",
        "https://www.kissakoira.xyz"
    ]
}));

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

// Luo Stripe-maksusession
app.post("/api/create-checkout-session", async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "eur",
                        product_data: {
                            name: "Testituote"
                        },
                        unit_amount: 500
                    },
                    quantity: 1
                }
            ],
            success_url:
                "https://kissakoira.xyz/?payment=success",
            cancel_url:
                "https://kissakoira.xyz/?payment=cancel"
        });

        res.json({
            url: session.url
        });

    } catch (error) {
        console.error("Stripe error:", error.message);

        res.status(500).json({
            error: "Maksun luominen epäonnistui."
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
