
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

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
    async (req, res) => {
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

            if (session.payment_status === "paid") {
                const shipping =
                    session.collected_information?.shipping_details;

                const address = shipping?.address || {};
                const customer = session.customer_details || {};

                const amount = (
                    (session.amount_total || 0) / 100
                ).toFixed(2);

                const orderInfo = `
                    <h2>Uusi tilaus! 🎉</h2>
                    <p><strong>Tilaus:</strong> ${session.id}</p>
                    <p><strong>Summa:</strong> ${amount} €</p>

                    <h3>Asiakkaan tiedot</h3>
                    <p><strong>Nimi:</strong> ${shipping?.name || customer.name || "Ei saatavilla"}</p>
                    <p><strong>Sähköposti:</strong> ${customer.email || "Ei saatavilla"}</p>
                    <p><strong>Puhelin:</strong> ${customer.phone || "Ei saatavilla"}</p>

                    <h3>Toimitusosoite</h3>
                    <p>
                        ${address.line1 || ""}<br>
                        ${address.line2 || ""}<br>
                        ${address.postal_code || ""} ${address.city || ""}<br>
                        ${address.country || ""}
                    </p>
                `;

                console.log("MAKSU ONNISTUI!");
                console.log("Tilaustunnus:", session.id);

                try {
                    const { data, error } = await resend.emails.send({
                        from: "Kissakoira <onboarding@resend.dev>",
                        to: [process.env.NOTIFICATION_EMAIL],
                        subject: "Uusi tilaus Kissakoira-kaupasta!",
                        html: orderInfo
                    });

                    if (error) {
                        console.error("Sähköpostivirhe:", error);
                    } else {
                        console.log("Tilausilmoitus lähetetty:", data.id);
                    }

                } catch (emailError) {
                    console.error(
                        "Sähköpostin lähetys epäonnistui:",
                        emailError.message
                    );
                }
            }
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

