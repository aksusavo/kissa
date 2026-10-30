
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const SENDER = "Kissakoira <tilaukset@kissakoira.xyz>";

// Muuntaa asiakkaan tiedot turvalliseen HTML-muotoon
function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

// CORS
app.use(cors({
    origin: [
        "https://kissakoira.xyz",
        "https://www.kissakoira.xyz"
    ]
}));

// WEBHOOK
// Tämä pitää olla ennen express.json()-middlewarea!
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

        if (event.type !== "checkout.session.completed") {
            return res.json({ received: true });
        }

        const session = event.data.object;

        // Lähetetään viestit vain maksetuista tilauksista
        if (session.payment_status !== "paid") {
            return res.json({ received: true });
        }

        const shipping =
            session.collected_information?.shipping_details ||
            session.shipping_details;

        const address = shipping?.address || {};
        const customer = session.customer_details || {};

        const name = escapeHtml(
            shipping?.name || customer.name || "Asiakas"
        );

        const email = customer.email || "";
        const phone = escapeHtml(
            customer.phone || "Ei ilmoitettu"
        );

        const street = escapeHtml(address.line1 || "");
        const apartment = escapeHtml(address.line2 || "");
        const postal = escapeHtml(address.postal_code || "");
        const city = escapeHtml(address.city || "");
        const country = escapeHtml(address.country || "");

        const amount = (
            (session.amount_total || 0) / 100
        ).toFixed(2);

        const orderId = session.id;

        console.log("MAKSU ONNISTUI!");
        console.log("Tilaustunnus:", orderId);
        console.log("Sähköposti:", email);

        // Yhteiset toimitustiedot
        const addressHtml = `
            ${street}<br>
            ${apartment ? apartment + "<br>" : ""}
            ${postal} ${city}<br>
            ${country}
        `;

        // 1. SÄHKÖPOSTI YRITTÄJÄLLE
        const adminHtml = `
            <h2>Uusi tilaus! 🎉</h2>

            <p><strong>Tilausnumero:</strong> ${orderId}</p>
            <p><strong>Maksettu summa:</strong> ${amount} €</p>

            <h3>Asiakkaan tiedot</h3>
            <p><strong>Nimi:</strong> ${name}</p>
            <p><strong>Sähköposti:</strong>
                ${escapeHtml(email || "Ei saatavilla")}
            </p>
            <p><strong>Puhelin:</strong> ${phone}</p>

            <h3>Toimitusosoite</h3>
            <p>${addressHtml}</p>

            <hr>
            <p>Uusi tilaus Kissakoira-verkkokaupasta.</p>
        `;

        try {
            const { data, error } = await resend.emails.send(
                {
                    from: SENDER,
                    to: [process.env.NOTIFICATION_EMAIL],
                    subject: "Uusi tilaus Kissakoira-kaupasta!",
                    html: adminHtml
                },
                {
                    idempotencyKey: `admin-order-${orderId}`
                }
            );

            if (error) {
                console.error("Admin email error:", error);
            } else {
                console.log(
                    "Tilausilmoitus lähetetty:",
                    data.id
                );
            }
        } catch (err) {
            console.error(
                "Admin email error:",
                err.message
            );
        }

        // 2. SÄHKÖPOSTI ASIAKKAALLE
        if (email) {
            const customerHtml = `
                <div style="
                    max-width: 600px;
                    margin: auto;
                    padding: 30px;
                    font-family: Arial, sans-serif;
                    color: #333;
                    background: #ffffff;
                ">

                    <div style="text-align: center;">
                        <h2 style="letter-spacing: 3px;">
                            KISSAKOIRA
                        </h2>

                        <div style="
                            font-size: 55px;
                            color: #25a64a;
                            margin: 25px;
                        ">✓</div>

                        <h1 style="color: #25a64a;">
                            Kiitos tilauksestasi!
                        </h1>

                        <p>Hei ${name}! ❤️</p>

                        <p>
                            Maksusi on vastaanotettu onnistuneesti.
                            Tilauksesi on tullut meille perille.
                        </p>
                    </div>

                    <div style="
                        background: #f5f5f5;
                        padding: 20px;
                        border-radius: 12px;
                        margin-top: 25px;
                    ">
                        <h3>Tilauksen tiedot</h3>

                        <p>
                            <strong>Tilausnumero:</strong><br>
                            ${orderId}
                        </p>

                        <p>
                            <strong>Maksettu summa:</strong><br>
                            ${amount} €
                        </p>

                        <p>
                            <strong>Maksun tila:</strong><br>
                            Maksu vastaanotettu ✓
                        </p>
                    </div>

                    <div style="margin-top: 25px;">
                        <h3>Toimitusosoite</h3>

                        <p>
                            ${name}<br>
                            ${addressHtml}
                        </p>
                    </div>

                    <div style="
                        text-align: center;
                        margin-top: 35px;
                        color: #888;
                    ">
                        <p>
                            Kiitos kun asioit meillä! 🐾
                        </p>

                        <a href="https://kissakoira.xyz"
                           style="color: #333;">
                            kissakoira.xyz
                        </a>
                    </div>

                </div>
            `;

            try {
                const { data, error } = await resend.emails.send(
                    {
                        from: SENDER,
                        to: [email],
                        subject: "Kiitos tilauksestasi! ❤️",
                        html: customerHtml
                    },
                    {
                        idempotencyKey: `customer-order-${orderId}`
                    }
                );

                if (error) {
                    console.error("Customer email error:", error);
                } else {
                    console.log(
                        "Asiakkaan vahvistus lähetetty:",
                        data.id
                    );
                }
            } catch (err) {
                console.error(
                    "Customer email error:",
                    err.message
                );
            }
        } else {
            console.log(
                "Asiakkaan sähköpostiosoite puuttuu."
            );
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
