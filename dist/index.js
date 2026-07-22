"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const mongodb_1 = require("mongodb");
// ==================== CONFIGURATIONS ====================
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
app.use((0, cors_1.default)({
    origin: [
        'http://localhost:3000',
        'http://localhost:5173', // Vite/React এর জন্য (যদি ব্যবহার করেন)
        process.env.CLIENT_URL || '' // ডেপ্লয় করা লাইভ ফ্রন্টএন্ড URL
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express_1.default.json());
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = 'sweetbyte-ai';
// ==================== DATABASE CONNECTION (race-condition safe) ====================
let db;
let dbConnectionPromise = null;
const connectDB = () => {
    if (db)
        return Promise.resolve(db);
    if (!dbConnectionPromise) {
        const client = new mongodb_1.MongoClient(MONGO_URI);
        dbConnectionPromise = client
            .connect()
            .then(() => {
            db = client.db(DB_NAME);
            console.log('🔥 MongoDB Connected Successfully!');
            return db;
        })
            .catch((err) => {
            console.error('❌ MongoDB Connection Error:', err);
            dbConnectionPromise = null; // পরের রিকোয়েস্টে আবার ট্রাই করার সুযোগ
            throw err;
        });
    }
    return dbConnectionPromise;
};
const getDB = () => {
    if (!db) {
        throw new Error('Database not initialized yet');
    }
    return db;
};
// প্রতিটা রিকোয়েস্টের আগে DB কানেকশন নিশ্চিত করে (cold start-এ ব্লক করে,
// warm instance-এ instant resolve হয়ে যায়)
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    }
    catch (err) {
        res.status(503).json({ error: 'Database connection failed' });
    }
});
// ==================== AUTH MIDDLEWARES ====================
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ message: "Unauthorized. Token missing." });
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ message: "Unauthorized. Token invalid." });
    }
    try {
        const currentDb = getDB();
        const session = await currentDb.collection('session').findOne({ token, expiresAt: { $gt: new Date() } });
        if (!session) {
            return res.status(401).json({ message: "Unauthorized. Session not found or expired." });
        }
        const userId = session.userId instanceof mongodb_1.ObjectId ? session.userId : new mongodb_1.ObjectId(session.userId);
        const user = await currentDb.collection('user').findOne({ _id: userId });
        if (!user) {
            return res.status(401).json({ message: "Unauthorized. User not found." });
        }
        req.user = {
            id: user._id.toString(),
            email: user.email,
            role: user.role,
        };
        next();
    }
    catch (error) {
        console.error("Token Verification Error:", error);
        return res.status(500).json({ message: "Authentication check failed." });
    }
};
const isAdmin = async (req, res, next) => {
    try {
        const email = req.user?.email;
        if (!email) {
            return res.status(401).json({ error: 'Unauthorized. User not authenticated.' });
        }
        const currentDb = getDB();
        const user = await currentDb.collection('user').findOne({ email });
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden. Admin access required.' });
        }
        next();
    }
    catch (error) {
        console.error('Authorization Middleware Error:', error);
        return res.status(500).json({ error: 'Authorization check failed.' });
    }
};
// ==================== API ROUTES ====================
app.get('/', (req, res) => {
    res.send('SweetByte AI Backend is running perfectly...');
});
/**
 * @route   POST /api/cakes
 * @desc    নতুন কেক আইটেম যোগ করা (শুধুমাত্র অ্যাডমিন)
 */
app.post('/api/cakes', verifyToken, isAdmin, async (req, res) => {
    try {
        const { title, imageUrl, priceOrPriority, category, userId, fullDescription, tags } = req.body;
        if (!title || !imageUrl || !priceOrPriority || !category || !userId) {
            return res.status(400).json({ error: 'Missing required fields to add a cake' });
        }
        const newCake = {
            title,
            imageUrl,
            priceOrPriority: Number(priceOrPriority), // টাইপ ফোর্স টু নাম্বার
            category,
            userId,
            fullDescription: fullDescription || '',
            tags: tags || [],
            createdAt: new Date()
        };
        const currentDb = getDB();
        const result = await currentDb.collection('cakes').insertOne(newCake);
        return res.status(201).json({ _id: result.insertedId, ...newCake });
    }
    catch (error) {
        console.error('Error inserting cake:', error);
        return res.status(500).json({ error: 'Failed to create cake item' });
    }
});
/**
 * @route   GET /api/cakes
 */
app.get('/api/cakes', async (req, res) => {
    try {
        const { search, category, page: pageParam, limit: limitParam } = req.query;
        const query = {};
        if (search && typeof search === 'string') {
            const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.title = { $regex: escaped, $options: 'i' };
        }
        if (category && typeof category === 'string') {
            query.category = { $regex: `^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
        }
        const page = Math.max(1, parseInt(pageParam) || 1);
        const limit = Math.max(1, Math.min(100, parseInt(limitParam) || 10));
        const skip = (page - 1) * limit;
        const currentDb = getDB();
        const [total, cakes] = await Promise.all([
            currentDb.collection('cakes').countDocuments(query),
            currentDb.collection('cakes')
                .find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray(),
        ]);
        return res.json({ total, cakes });
    }
    catch (error) {
        console.error('Error fetching cakes:', error);
        return res.status(500).json({ error: 'Failed to fetch cakes' });
    }
});
/**
 * @route   GET /api/cakes/:id
 */
app.get('/api/cakes/:id', async (req, res) => {
    try {
        const id = req.params.id;
        if (!mongodb_1.ObjectId.isValid(id))
            return res.status(400).json({ error: 'Invalid Cake ID format' });
        const currentDb = getDB();
        const cake = await currentDb.collection('cakes').findOne({ _id: new mongodb_1.ObjectId(id) });
        if (!cake)
            return res.status(404).json({ error: 'Cake not found' });
        return res.json(cake);
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to fetch cake details' });
    }
});
/**
 * @route   DELETE /api/cakes/:id
 */
app.delete('/api/cakes/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        if (!mongodb_1.ObjectId.isValid(id))
            return res.status(400).json({ error: 'Invalid Cake ID format' });
        const currentDb = getDB();
        const result = await currentDb.collection('cakes').deleteOne({ _id: new mongodb_1.ObjectId(id) });
        if (result.deletedCount === 0)
            return res.status(404).json({ error: 'Cake not found' });
        return res.json({ message: 'Cake item deleted successfully' });
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to delete cake item' });
    }
});
/**
 * @route   POST /api/orders
 */
app.post('/api/orders', verifyToken, async (req, res) => {
    try {
        const { userId, items, deliveryAddress, phoneNumber } = req.body;
        if (!items || items.length === 0)
            return res.status(400).json({ error: 'Cart is empty.' });
        if (!userId || !deliveryAddress || !phoneNumber)
            return res.status(400).json({ error: 'Missing properties.' });
        const newOrder = {
            userId,
            items: items.map((item) => ({
                ...item,
                priceOrPriority: Number(item.priceOrPriority) // সেফটি পার্সিং
            })),
            deliveryAddress,
            phoneNumber,
            status: 'Pending',
            createdAt: new Date()
        };
        const currentDb = getDB();
        const result = await currentDb.collection('orders').insertOne(newOrder);
        return res.status(201).json({ _id: result.insertedId, ...newOrder });
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to place order' });
    }
});
/**
 * @route   POST /api/cart
 */
app.post('/api/cart', verifyToken, async (req, res) => {
    try {
        const { userId, cakeId, quantity } = req.body;
        if (!userId || !cakeId)
            return res.status(400).json({ error: 'Missing userId or cakeId' });
        const itemQuantity = quantity ? parseInt(quantity) : 1;
        const currentDb = getDB();
        const existingItem = await currentDb.collection('cart').findOne({ userId, cakeId });
        if (existingItem) {
            await currentDb.collection('cart').updateOne({ userId, cakeId }, { $inc: { quantity: itemQuantity } });
            return res.status(200).json({ message: 'Cart item quantity updated' });
        }
        else {
            const newCartItem = { userId, cakeId, quantity: itemQuantity, addedAt: new Date() };
            await currentDb.collection('cart').insertOne(newCartItem);
            return res.status(201).json({ message: 'Added to cart successfully', data: newCartItem });
        }
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to add item to cart' });
    }
});
/**
 * @route   POST /api/wishlist/toggle
 */
app.post('/api/wishlist/toggle', verifyToken, async (req, res) => {
    try {
        const { userId, cakeId } = req.body;
        if (!userId || !cakeId)
            return res.status(400).json({ error: 'Missing userId or cakeId' });
        const currentDb = getDB();
        const existingWish = await currentDb.collection('wishlist').findOne({ userId, cakeId });
        if (existingWish) {
            await currentDb.collection('wishlist').deleteOne({ userId, cakeId });
            return res.status(200).json({ isSaved: false, message: 'Item removed from wishlist' });
        }
        else {
            const newWish = { userId, cakeId, savedAt: new Date() };
            await currentDb.collection('wishlist').insertOne(newWish);
            return res.status(201).json({ isSaved: true, message: 'Item saved to wishlist' });
        }
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to toggle wishlist item' });
    }
});
/**
 * @route   GET /api/wishlist/:userId
 */
app.get('/api/wishlist/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const currentDb = getDB();
        const items = await currentDb.collection('wishlist').aggregate([
            { $match: { userId } },
            {
                $lookup: {
                    from: 'cakes',
                    let: { cakeIdStr: '$cakeId' },
                    pipeline: [
                        { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$cakeIdStr'] } } }
                    ],
                    as: 'cake'
                }
            },
            { $unwind: { path: '$cake', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 1,
                    cakeId: 1,
                    savedAt: 1,
                    title: '$cake.title',
                    priceOrPriority: '$cake.priceOrPriority',
                    imageUrl: '$cake.imageUrl'
                }
            },
            { $sort: { savedAt: -1 } }
        ]).toArray();
        return res.json(items);
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to fetch wishlist items' });
    }
});
/**
 * @route   GET /api/cart/:userId
 */
app.get('/api/cart/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const currentDb = getDB();
        const cartItems = await currentDb.collection('cart').aggregate([
            { $match: { userId } },
            {
                $lookup: {
                    from: 'cakes',
                    let: { cakeIdStr: '$cakeId' },
                    pipeline: [
                        { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$cakeIdStr'] } } }
                    ],
                    as: 'cake'
                }
            },
            { $unwind: { path: '$cake', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 1,
                    cakeId: 1,
                    quantity: 1,
                    addedAt: 1,
                    title: '$cake.title',
                    priceOrPriority: '$cake.priceOrPriority',
                    imageUrl: '$cake.imageUrl'
                }
            },
            { $sort: { addedAt: -1 } }
        ]).toArray();
        return res.json(cartItems);
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to fetch cart items' });
    }
});
/**
 * @route   DELETE /api/cart/clear/:userId
 */
app.delete('/api/cart/clear/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const currentDb = getDB();
        await currentDb.collection('cart').deleteMany({ userId });
        return res.json({ message: 'Cart cleared successfully' });
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to clear cart' });
    }
});
/**
 * @route   DELETE /api/cart/:userId/:cakeId
 */
app.delete('/api/cart/:userId/:cakeId', verifyToken, async (req, res) => {
    try {
        const { userId, cakeId } = req.params;
        const currentDb = getDB();
        const result = await currentDb.collection('cart').deleteOne({ userId, cakeId });
        if (result.deletedCount === 0)
            return res.status(404).json({ error: 'Cart item not found' });
        return res.json({ message: 'Item removed from cart' });
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to remove cart item' });
    }
});
/**
 * @route   GET /api/cart/count/:userId
 * @desc    ইউজারের কার্টের মোট আইটেম সংখ্যা
 */
app.get('/api/cart/count/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const currentDb = getDB();
        const count = await currentDb.collection('cart').countDocuments({ userId });
        return res.json({ count });
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to count cart items' });
    }
});
// ==================== ADMIN ORDER MANAGEMENT ROUTES ====================
/**
 * @route   GET /api/admin/orders
 * @desc    সব গ্রাহকের অর্ডার হিস্টোরি দেখা (শুধুমাত্র অ্যাডমিন)
 */
app.get('/api/admin/orders', verifyToken, isAdmin, async (req, res) => {
    try {
        const currentDb = getDB();
        const orders = await currentDb.collection('orders')
            .find()
            .sort({ createdAt: -1 })
            .toArray();
        return res.json(orders);
    }
    catch (error) {
        console.error('Error fetching admin orders:', error);
        return res.status(500).json({ error: 'Failed to fetch all orders' });
    }
});
/**
 * @route   PATCH /api/admin/orders/:orderId/status
 * @desc    অর্ডারের স্ট্যাটাস মডিফাই করা (FIXED for MongoDB v6+)
 */
app.patch('/api/admin/orders/:orderId/status', verifyToken, isAdmin, async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body;
        if (!mongodb_1.ObjectId.isValid(orderId)) {
            return res.status(400).json({ error: 'Invalid Order ID format' });
        }
        const validStatuses = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status value' });
        }
        const currentDb = getDB();
        // টাইপ সেফটি নিশ্চিত করতে এবং টাইপস্ক্রিপ্ট এরর এড়াতে টাইপ কাস্টিং করা হয়েছে
        const updatedOrder = await currentDb.collection('orders').findOneAndUpdate({ _id: new mongodb_1.ObjectId(orderId) }, { $set: { status: status } }, { returnDocument: 'after' }); // এখানে টাইপ কাস্ট করে দেওয়া হলো
        if (!updatedOrder) {
            return res.status(404).json({ error: 'Order not found to update' });
        }
        return res.json(updatedOrder);
    }
    catch (error) {
        console.error('Error updating order status:', error);
        return res.status(500).json({ error: 'Failed to update order status' });
    }
});
/**
 * @route   GET /api/orders/:userId
 * @desc    নির্দিষ্ট কাস্টমারের অর্ডার হিস্টোরি
 */
app.get('/api/orders/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const currentDb = getDB();
        const orders = await currentDb.collection('orders')
            .find({ userId })
            .sort({ createdAt: -1 })
            .toArray();
        return res.json(orders);
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to fetch orders' });
    }
});
/**
 * @route   POST /api/ai/generate-cake-details
 * @desc    Gemini AI দিয়ে কেকের বিস্তারিত বর্ণনা ও ট্যাগ জেনারেট করা
 */
app.post('/api/ai/generate-cake-details', async (req, res) => {
    try {
        const { title, category } = req.body;
        if (!title || !category) {
            return res.status(400).json({ error: 'Missing required fields: title and category' });
        }
        if (typeof title !== 'string' || typeof category !== 'string') {
            return res.status(400).json({ error: 'title and category must be strings' });
        }
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured' });
        }
        const prompt = `You are a professional pastry chef and bakery copywriter. Always respond with valid JSON only.

Generate a professional cake description and tags for a cake with the following details:

Title: "${title}"
Category: "${category}"

You MUST respond with ONLY valid JSON in this exact format:
{
  "fullDescription": "A professional, engaging description (2 paragraphs) that describes the cake's likely flavors, appearance, texture, and ideal occasions. Never use placeholder or lorem ipsum text.",
  "tags": ["tag1", "tag2", "tag3", "tag4"]
}

Requirements:
- fullDescription must be unique, compelling, and specific to this cake title and category
- fullDescription must NOT contain any placeholder or dummy text
- tags array must contain exactly 4 relevant, searchable tags
- Tags should be single words or short phrases (e.g. "chocolate", "birthday", "eggless")`;
        const fallback = () => ({
            fullDescription: `Indulge in our exquisite ${title || 'Specialty Cake'}, handcrafted with love and baked to perfection. Featuring moist layers infused with fresh ingredients and topped with our signature velvet frosting, this delightful creation is perfect for any ${category || 'Celebration'}.`,
            tags: [
                (category || 'cake').toLowerCase().replace(/\s+/g, '-'),
                'freshly-baked',
                'delicious',
                'premium-quality'
            ]
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        clearTimeout(timeout);
        if (geminiRes.status === 503) {
            console.warn('Gemini 503 (high demand). Retrying once after 1s...');
            await new Promise(r => setTimeout(r, 1000));
            const retryController = new AbortController();
            const retryTimeout = setTimeout(() => retryController.abort(), 15000);
            geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: retryController.signal,
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            clearTimeout(retryTimeout);
        }
        if (!geminiRes.ok) {
            const rawErr = await geminiRes.text();
            console.error('Gemini error response:', geminiRes.status, rawErr);
            const status = geminiRes.status;
            if (status === 429 || status === 503) {
                console.warn('Gemini rate-limited or unavailable. Returning fallback data.');
                return res.status(200).json(fallback());
            }
            if (status === 404 || rawErr.toLowerCase().includes('not found') || rawErr.toLowerCase().includes('model not')) {
                return res.status(500).json({ error: 'AI model unavailable. Please contact the administrator.' });
            }
            return res.status(500).json({ error: rawErr || 'Failed to generate cake details' });
        }
        const geminiData = await geminiRes.json();
        const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = responseText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        }
        catch {
            return res.status(500).json({ error: 'AI returned invalid JSON', raw: responseText });
        }
        if (!parsed.fullDescription || typeof parsed.fullDescription !== 'string') {
            return res.status(500).json({ error: 'AI response missing fullDescription' });
        }
        if (!Array.isArray(parsed.tags) || parsed.tags.length !== 4 || !parsed.tags.every(t => typeof t === 'string')) {
            return res.status(500).json({ error: 'AI response must contain exactly 4 string tags' });
        }
        return res.json(parsed);
    }
    catch (error) {
        console.error('Gemini API Error:', JSON.stringify({ message: error?.message, stack: error?.stack?.split('\n')[0] }));
        return res.status(500).json({
            error: error?.message || 'Failed to generate cake details',
        });
    }
});
// ==================== SERVER STARTUP ====================
if (process.env.NODE_ENV !== 'production') {
    // লোকাল dev: DB connect হওয়ার পর সার্ভার listen করান
    connectDB()
        .then(() => {
        app.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
        });
    })
        .catch((err) => {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    });
}
// production (Vercel serverless)-এ আলাদা করে listen/connect কল করার দরকার নেই —
// উপরের app.use middleware প্রতিটা রিকোয়েস্টে connectDB() কল করে,
// এবং একই warm instance-এ পরের রিকোয়েস্টগুলোর জন্য এটা cached থাকে।
exports.default = app;
