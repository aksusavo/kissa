
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const SENDER = "Kissakoira <tilaukset@kissakoira.xyz>";

const PRODUCTS = {
    paita1: {
        name: "Testipaita 01",
        price: 1990,
        image: "https://kissakoira.xyz/photos1/paita1.jpg"
    },
    paita2: {
        name: "Testipaita 02",
        price: 1990,
        image: "https://kissakoira.xyz/photos1/paita2.jpg"
    },
    paita3: {
        name: "Testipaita 03",
        price: 2490,
        image: "https://kissakoira.xyz/photos1/paita3.jpg"
    }
};

const SIZES = ["S", "M", "L"];

function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

app.use(cors({
    origin: [
        "https://kissakoira.xyz",
        "https://www.kissakoira.xyz"
    ]
}));

// STRIPE WEBHOOK
// Raw body täytyy käsitellä ennen express.json()-käsittelyä.
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

        if (session.payment_status !== "paid") {
            return res.json({ received: true });
        }

        try {
            // Haetaan kaikki maksetun tilauksen tuoterivit Stripe:stä.
            const lineItems = await stripe.checkout.sessions.listLineItems(
                session.id,
                { limit: 100 }
            );

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

            const orderRows = lineItems.data.map(item => {
                const description = escapeHtml(
                    item.description || "Tuote"
                );

                const quantity = item.quantity || 1;

                const rowTotal = (
                    (item.amount_total || 0) / 100
                ).toFixed(2);

                return `
                    <tr>
                        <td style="padding: 8px; border-bottom: 1px solid #ddd;">
                            ${description}
                        </td>
                        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">
                            ${quantity} kpl
                        </td>
                        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">
                            ${rowTotal} €
                        </td>
                    </tr>
                `;
            }).join("");

            const orderTable = `
                <table style="
                    width: 100%;
                    border-collapse: collapse;
                    text-align: left;
                ">
                    <thead>
                        <tr>
                            <th style="padding: 8px; border-bottom: 2px solid #ccc;">
                                Tuote
                            </th>
                            <th style="padding: 8px; border-bottom: 2px solid #ccc; text-align: center;">
                                Määrä
                            </th>
                            <th style="padding: 8px; border-bottom: 2px solid #ccc; text-align: right;">
                                Yhteensä
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        ${orderRows}
                    </tbody>
                </table>
            `;

            const addressHtml = `
                ${street}<br>
                ${apartment ? apartment + "<br>" : ""}
                ${postal} ${city}<br>
                ${country}
            `;

            console.log("MAKSU ONNISTUI!");
            console.log("Tilaustunnus:", orderId);
            console.log("Tuoterivit:", lineItems.data.length);
            console.log("Sähköposti:", email);
            console.log("Toimitusosoite:", address);

            // ILMOITUS YLLÄPITÄJÄLLE
            const adminHtml = `
                <h2>Uusi tilaus! 🎉</h2>

                <p>
                    <strong>Tilausnumero:</strong>
                    ${escapeHtml(orderId)}
                </p>

                <h3>Tilatut tuotteet</h3>
                ${orderTable}

                <p>
                    <strong>Maksettu summa:</strong>
                    ${amount} €
                </p>

                <h3>Asiakkaan tiedot</h3>

                <p><strong>Nimi:</strong> ${name}</p>
                <p>
                    <strong>Sähköposti:</strong>
                    ${escapeHtml(email || "Ei saatavilla")}
                </p>
                <p><strong>Puhelin:</strong> ${phone}</p>

                <h3>Toimitusosoite</h3>
                <p>${addressHtml}</p>
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
                        "Ylläpitäjän sähköposti lähetetty:",
                        data.id
                    );
                }
            } catch (err) {
                console.error("Admin email error:", err.message);
            }

            // VAHVISTUS ASIAKKAALLE
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
                                ${escapeHtml(orderId)}
                            </p>

                            ${orderTable}

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
                            <p>Kiitos kun asioit meillä! 🐾</p>

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
            }

            return res.json({ received: true });

        } catch (err) {
            console.error("Webhook processing error:", err);
            return res.status(500).send("Webhook processing failed");
        }
    }
);

// Tavallisten pyyntöjen JSON-käsittely
app.use(express.json());

// API:n testaus
app.get("/", (req, res) => {
    res.send("Kissakoira API toimii!");
});

app.get("/api/test", (req, res) => {
    res.json({
        status: "ok",
        message: "API-yhteys toimii!"
    });
});

// TUOTTEIDEN LISTAUS
app.get("/api/products", (req, res) => {
    const products = Object.entries(PRODUCTS).map(
        ([id, product]) => ({
            id,
            name: product.name,
            price: product.price,
            image: product.image,
            sizes: SIZES
        })
    );

    res.json(products);
});

// MAKSUSESSION LUOMINEN OSTOSKORISTA
app.post("/api/create-checkout-session", async (req, res) => {
    try {
        const items = req.body.items;

        if (
            !Array.isArray(items) ||
            items.length === 0 ||
            items.length > 30
        ) {
            return res.status(400).json({
                error: "Ostoskori on tyhjä tai virheellinen."
            });
        }

        const lineItems = [];

        for (const item of items) {
            const product = PRODUCTS[item.productId];
            const size = item.size;
            const quantity = Number(item.quantity);

            if (!product) {
                return res.status(400).json({
                    error: "Ostoskori sisältää tuntemattoman tuotteen."
                });
            }

            if (!SIZES.includes(size)) {
                return res.status(400).json({
                    error: "Valitse tuotteelle koko S, M tai L."
                });
            }

            if (
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                quantity > 10
            ) {
                return res.status(400).json({
                    error: "Tuotteen määrä ei ole kelvollinen."
                });
            }

            lineItems.push({
                price_data: {
                    currency: "eur",
                    product_data: {
                        name: `${product.name} (koko ${size})`,
                        images: [product.image],
                        metadata: {
                            productId: item.productId,
                            size: size
                        }
                    },
                    unit_amount: product.price
                },
                quantity: quantity
            });
        }

        const session = await stripe.checkout.sessions.create({
            mode: "payment",

            customer_creation: "always",

            billing_address_collection: "required",

            shipping_address_collection: {
                allowed_countries: ["FI"]
            },

            phone_number_collection: {
                enabled: true
            },

            line_items: lineItems,

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

// KÄYNNISTÄ PALVELIN
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
