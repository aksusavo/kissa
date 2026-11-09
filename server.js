
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { Resend } = require("resend");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const SENDER = "Kissakoira <tilaukset@kissakoira.xyz>";

const PRODUCTS = {
    paita1: {
        name: "kissakoira.–black/pink",
        price: 1990,
        image: "https://kissakoira.xyz/photos1/paita1.jpg"
    },
    paita2: {
        name: "kissakoira.–180",
        price: 1990,
        image: "https://kissakoira.xyz/photos1/paita2.jpg"
    },
    paita3: {
        name: "kissakoira.–international",
        price: 2290,
        image: "https://kissakoira.xyz/photos1/paita3.jpg"
    }
};

// PRINTFULIN STORE-VARIANTIT
const PRINTFUL_VARIANTS = {
    paita1: {
        S: 5629815261,
        M: 5629815262,
        L: 5629815263,
        XL: 5629815264
    },
    paita2: {
        S: 5629811080,
        M: 5629811081,
        L: 5629811082,
        XL: 5629811083
    },
    paita3: {
        S: 5629807785,
        M: 5629807786,
        L: 5629807787,
        XL: 5629807788
    }
};

const SIZES = ["S", "M", "L", "XL"];

// CORS-ASETUKSET
const allowedOrigins = [
    "https://kissakoira.xyz",
    "https://www.kissakoira.xyz",
	"https://kissa-static.onrender.com"
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log("CORS-estetty origin:", origin);
            callback(new Error("Origin ei ole sallittu."));
        }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204
};

// CORS käsitellään ennen kaikkia API-reittejä.
app.use(cors(corsOptions));

// Erillinen OPTIONS-käsittely.
app.options(/.*/, cors(corsOptions));

function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[char]);
}

// GOOGLE SHEETS -TILAUSKIRJAUS
async function logOrderToSheets(order) {
    const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
    const secret = process.env.GOOGLE_SCRIPT_SECRET;

    if (!scriptUrl || !secret) {
        throw new Error(
            "Google Sheets -asetukset puuttuvat Renderistä.");
    }

    const response = await fetch(scriptUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            secret: secret,
            ...order
        })
    });

    if (!response.ok) {
        throw new Error(
            "Google Sheets HTTP-virhe: " + response.status);
    }

    const result = await response.json();

    if (!result.success) {
        throw new Error(
            "Google Sheets -kirjaus epäonnistui: " +
            (result.error || "Tuntematon virhe"));
    }

    if (result.duplicate) {
        console.log(
            "Tilaus oli jo Google Sheetsissä:",
            order.orderId);
    } else {
        console.log(
            "Tilaus kirjattu Google Sheetsiin:",
            order.orderId);
    }
}

// PRINTFUL-TILAUKSEN LUONTI
async function createPrintfulOrder({
    stripeSessionId,
    lineItems,
    rawName,
    email,
    rawPhone,
    address
}) {
    const token = process.env.PRINTFUL_API_TOKEN;

    if (!token) {
        throw new Error("PRINTFUL_API_TOKEN puuttuu.");
    }

    // Luodaan Stripe-istunnosta yksilöllinen ulkoinen tunniste.
    const externalId = "KK_" + crypto
        .createHash("sha256")
        .update(stripeSessionId)
        .digest("hex")
        .slice(0, 24);

    const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
    };

    // Tarkistetaan, onko tilaus jo olemassa.
    const existingResponse = await fetch(
`https://api.printful.com/orders/@${externalId}`, {
            method: "GET",
            headers
        });

    if (existingResponse.ok) {
        const existingData = await existingResponse.json();

        console.log(
            "Printful-tilaus löytyi jo:",
            existingData.result?.id);

        return existingData.result;
    }

    if (existingResponse.status !== 404) {
        const errorText = await existingResponse.text();

        throw new Error(
`Printful-tarkistus epäonnistui: ${errorText}`);
    }

    // Muutetaan Stripen tuotteet Printfulin tuotteiksi.
    const items = lineItems.map(item => {
        const product = item.price?.product;

        const metadata =
            typeof product === "object"
             ? product.metadata || {}
         : {};

        const productId = metadata.productId;
        const size = metadata.size;

        const syncVariantId =
            PRINTFUL_VARIANTS[productId]?.[size];

        const quantity = item.quantity || 1;

        if (!syncVariantId) {
            throw new Error(
`Tuntematon Printful-tuote tai koko: ${productId}, ${size}`);
        }

        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new Error("Virheellinen tuotemäärä.");
        }

        return {
            sync_variant_id: syncVariantId,
            quantity
        };
    });

    // Asiakkaan toimitustiedot.
    const recipient = {
        name: rawName,
        address1: address.line1 || "",
        city: address.city || "",
        country_code: (address.country || "").toUpperCase(),
        zip: address.postal_code || "",
        email: email || undefined,
        phone: rawPhone !== "Ei ilmoitettu"
         ? rawPhone
         : undefined
    };

    if (address.line2) {
        recipient.address2 = address.line2;
    }

    if (
        !recipient.name ||
        !recipient.address1 ||
        !recipient.city ||
        !recipient.country_code ||
        !recipient.zip) {
        throw new Error(
            "Toimitusosoitteesta puuttuu tietoja.");
    }

    // Luodaan Printful-tilaus luonnoksena.
    const response = await fetch(
            "https://api.printful.com/orders?confirm=0", {
            method: "POST",
            headers,
            body: JSON.stringify({
                external_id: externalId,
                recipient,
                items
            })
        });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.code !== 200) {
        throw new Error(
            "Printful-tilauksen luonti epäonnistui: " +
            JSON.stringify(result));
    }

    console.log(
        "Printful-tilaus luotu luonnoksena:",
        result.result?.id);

    return result.result;
}

// STRIPE WEBHOOK
// Raw body täytyy käsitellä ennen express.json()-käsittelyä.
app.post(
    "/api/webhook",
    express.raw({
        type: "application/json"
    }),
    async(req, res) => {
    const signature = req.headers["stripe-signature"];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET.trim());
    } catch (err) {
        console.error(
            "Webhook signature error:",
            err.message);
        return res.status(400).send("Webhook error");
    }

    if (event.type !== "checkout.session.completed") {
        return res.json({
            received: true
        });
    }

    const session = event.data.object;

    if (session.payment_status !== "paid") {
        return res.json({
            received: true
        });
    }

    try {
        // Haetaan kaikki tilauksen tuoterivit Stripestä.
        const lineItems =
            await stripe.checkout.sessions.listLineItems(
                session.id, {
                limit: 100,
                expand: ["data.price.product"]
            });

        const shipping =
            session.collected_information?.shipping_details ||
            session.shipping_details;

        const address = shipping?.address || {};
        const customer = session.customer_details || {};

        const rawName =
            shipping?.name || customer.name || "Asiakas";

        const name = escapeHtml(rawName);
        const email = customer.email || "";

        const rawPhone =
            customer.phone || "Ei ilmoitettu";

        const phone = escapeHtml(rawPhone);

        const street = escapeHtml(address.line1 || "");
        const apartment = escapeHtml(address.line2 || "");
        const postal = escapeHtml(address.postal_code || "");
        const city = escapeHtml(address.city || "");
        const country = escapeHtml(address.country || "");

        const amount = (
            (session.amount_total || 0) / 100).toFixed(2);

        const orderId = session.id;

        // Tuotteet Google Sheetsiin.
        const productsForSheet = lineItems.data.map(item => {
            const description =
                item.description || "Tuote";

            const quantity = item.quantity || 1;

            return `${description} x ${quantity}`;
        }).join(", ");
        // PRINTFUL-TILAUKSEN LUONTI
        await createPrintfulOrder({
            stripeSessionId: session.id,
            lineItems: lineItems.data,
            rawName,
            email,
            rawPhone,
            address
        });

        const addressForSheet = [
            address.line1,
            address.line2,
            [
                address.postal_code,
                address.city
            ].filter(Boolean).join(" "),
            address.country
        ].filter(Boolean).join(", ");

        // KIRJATAAN TILAUS GOOGLE SHEETSIIN.
        await logOrderToSheets({
            orderId: orderId,
            createdAt: new Date(
                session.created * 1000).toISOString(),
            customerName: rawName,
            email: email,
            phone: rawPhone,
            products: productsForSheet,
            totalCents: session.amount_total || 0,
            address: addressForSheet
        });

        // SÄHKÖPOSTIN TUOTERIVIT
        const orderRows = lineItems.data.map(item => {
            const description = escapeHtml(
                    item.description || "Tuote");

            const quantity = item.quantity || 1;

            const rowTotal = (
                (item.amount_total || 0) / 100).toFixed(2);

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
            const { data, error } = await resend.emails.send({
                from: SENDER,
                to: [process.env.NOTIFICATION_EMAIL],
                subject: "Uusi tilaus Kissakoira-kaupasta!",
                html: adminHtml
            }, {
                idempotencyKey: `admin-order-${orderId}`
            });

            if (error) {
                console.error("Admin email error:", error);
            } else {
                console.log(
                    "Ylläpitäjän sähköposti lähetetty:",
                    data.id);
            }
        } catch (err) {
            console.error(
                "Admin email error:",
                err.message);
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
                const { data, error } = await resend.emails.send({
                    from: SENDER,
                    to: [email],
                    subject: "Kiitos tilauksestasi! ❤️",
                    html: customerHtml
                }, {
                    idempotencyKey: `customer-order-${orderId}`
                });

                if (error) {
                    console.error(
                        "Customer email error:",
                        error);
                } else {
                    console.log(
                        "Asiakkaan vahvistus lähetetty:",
                        data.id);
                }
            } catch (err) {
                console.error(
                    "Customer email error:",
                    err.message);
            }
        }

        return res.json({
            received: true
        });

    } catch (err) {
        console.error("Webhook processing error:", err);
        return res.status(500).send(
            "Webhook processing failed");
    }
});

// Tavallisten pyyntöjen JSON-käsittely
app.use(express.json());

// API:N TESTAUS
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
            }));

    res.json(products);
});

// MAKSUSESSION LUOMINEN OSTOSKORISTA
app.post("/api/create-checkout-session", async(req, res) => {
    try {
        const items = req.body.items;

        if (
            !Array.isArray(items) ||
            items.length === 0 ||
            items.length > 30) {
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
                    error: "Valitse tuotteelle koko S, M, L tai XL."
                });
            }

            if (
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                quantity > 10) {
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
