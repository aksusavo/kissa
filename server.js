
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// CORS
app.use(cors({
    origin: [
        "https://kissakoira.xyz",
        "https://www.kissakoira.xyz"
    ]
}));

// Webhook pitää määritellä ENNEN express.json()-middlewarea!
app.post(
    "/api/webhook",
    express.raw({ type: "application/json" }),
    (req, res) => {
        const signature = req.headers["stripe-signature"];

        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET.trim()
            );
        } catch (err) {
            console.error("Webhook signature error:", err.message);
            return res.status(400).send("Webhook error");
        }

        if (event.type === "checkout.session.completed") {
            const session = event.data.object;

            console.log("MAKSU ONNISTUI!");

            console.log("Tilaustunnus:", session.id);
            console.log("Sähköposti:", session.customer_details?.email);
            console.log("Puhelin:", session.customer_details?.phone);
            const shipping =
                session.collected_information?.shipping_details;

            console.log("Toimituksen nimi:", shipping?.name);
            console.log("Toimitusosoite:", shipping?.address);
            console.log("Katuosoite:", shipping?.address?.line1);
            console.log("Asunto:", shipping?.address?.line2);
            console.log("Postinumero:", shipping?.address?.postal_code);
            console.log("Kaupunki:", shipping?.address?.city);
            console.log("Maa:", shipping?.address?.country);

            // Lisätään sähköposti-ilmoitus myöhemmin.
        }

        res.json({ received: true });
    }
);

// Tavallisten pyyntöjen JSON-käsittely
app.use(express.json());

// Etusivu
app.get("/", (req, res) => {
    res.send("Kissakoira API toimii!");
});

// API-testi
app.get("/api/test", (req, res) => {
    res.json({
        status: "ok",
        message: "API-yhteys toimii!"
    });
});

// Luo maksusessio
app.post("/api/create-checkout-session", async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            mode: "payment",

            customer_creation: "always",

            // Laskutusosoite
            billing_address_collection: "required",

            // Toimitusosoite
            shipping_address_collection: {
                allowed_countries: ["FI"]
            },

            // Puhelinnumero
            phone_number_collection: {
                enabled: true
            },

            // Tuote ja hinta
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
                "https://kissakoira.xyz/maksu-onnistui.html",

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

// Käynnistä palvelin
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

