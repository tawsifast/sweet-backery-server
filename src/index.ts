import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ObjectId, Db, Filter } from 'mongodb';

// ==================== TYPE INTERFACES ====================
export interface ICake {
  _id?: ObjectId;
  title: string;
  imageUrl: string;
  priceOrPriority: number;
  category: string;
  userId: string;
  fullDescription: string;
  tags: string[];
  createdAt: Date;
}

export interface IOrderItem {
  cakeId: string;
  title: string;
  priceOrPriority: number;
  quantity: number;
}

export interface IOrder {
  _id?: ObjectId;
  userId: string;
  items: IOrderItem[];
  deliveryAddress: string;
  phoneNumber: string;
  status: 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled';
  createdAt: Date;
}

export interface AIGeneratedCakeDetails {
  fullDescription: string;
  tags: string[];
}

// ==================== CONFIGURATIONS ====================
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173', // Vite/React এর জন্য (যদি ব্যবহার করেন)
    process.env.CLIENT_URL || '' // ডেপ্লয় করা লাইভ ফ্রন্টএন্ড URL
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = 'sweetbyte-ai';

// ==================== DATABASE CONNECTION (race-condition safe) ====================
let db: Db;
let dbConnectionPromise: Promise<Db> | null = null;

const connectDB = (): Promise<Db> => {
  if (db) return Promise.resolve(db);

  if (!dbConnectionPromise) {
    const client = new MongoClient(MONGO_URI);
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

const getDB = (): Db => {
  if (!db) {
    throw new Error('Database not initialized yet');
  }
  return db;
};

// প্রতিটা রিকোয়েস্টের আগে DB কানেকশন নিশ্চিত করে (cold start-এ ব্লক করে,
// warm instance-এ instant resolve হয়ে যায়)
app.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database connection failed' });
  }
});

// ==================== AUTH MIDDLEWARES ====================

const verifyToken = async (req: any, res: any, next: any) => {
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

    const userId = session.userId instanceof ObjectId ? session.userId : new ObjectId(session.userId as string);
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
  } catch (error) {
    console.error("Token Verification Error:", error);
    return res.status(500).json({ message: "Authentication check failed." });
  }
};

const isAdmin = async (req: Request, res: Response, next: any): Promise<any> => {
  try {
    const email = (req as any).user?.email;
    if (!email) {
      return res.status(401).json({ error: 'Unauthorized. User not authenticated.' });
    }

    const currentDb = getDB();
    const user = await currentDb.collection('user').findOne({ email });

    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden. Admin access required.' });
    }

    next();
  } catch (error) {
    console.error('Authorization Middleware Error:', error);
    return res.status(500).json({ error: 'Authorization check failed.' });
  }
};

// ==================== API ROUTES ====================

app.get('/', (req: Request, res: Response) => {
  res.send('SweetByte AI Backend is running perfectly...');
});

/**
 * @route   POST /api/cakes
 * @desc    নতুন কেক আইটেম যোগ করা (শুধুমাত্র অ্যাডমিন)
 */
app.post('/api/cakes', verifyToken, isAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { title, imageUrl, priceOrPriority, category, userId, fullDescription, tags } = req.body;

    if (!title || !imageUrl || !priceOrPriority || !category || !userId) {
      return res.status(400).json({ error: 'Missing required fields to add a cake' });
    }

    const newCake: ICake = {
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
    const result = await currentDb.collection<ICake>('cakes').insertOne(newCake);

    return res.status(201).json({ _id: result.insertedId, ...newCake });
  } catch (error) {
    console.error('Error inserting cake:', error);
    return res.status(500).json({ error: 'Failed to create cake item' });
  }
});

/**
 * @route   GET /api/cakes
 */
app.get('/api/cakes', async (req: Request, res: Response): Promise<any> => {
  try {
    const { search, category, page: pageParam, limit: limitParam } = req.query;
    const query: Filter<ICake> = {};

    if (search && typeof search === 'string') {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.title = { $regex: escaped, $options: 'i' };
    }
    if (category && typeof category === 'string') {
      query.category = { $regex: `^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
    }

    const page = Math.max(1, parseInt(pageParam as string) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(limitParam as string) || 10));
    const skip = (page - 1) * limit;

    const currentDb = getDB();
    const [total, cakes] = await Promise.all([
      currentDb.collection<ICake>('cakes').countDocuments(query),
      currentDb.collection<ICake>('cakes')
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    return res.json({ total, cakes });
  } catch (error) {
    console.error('Error fetching cakes:', error);
    return res.status(500).json({ error: 'Failed to fetch cakes' });
  }
});

/**
 * @route   GET /api/cakes/:id
 */
app.get('/api/cakes/:id', async (req: Request, res: Response): Promise<any> => {
  try {
    const id = req.params.id as string;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid Cake ID format' });

    const currentDb = getDB();
    const cake = await currentDb.collection<ICake>('cakes').findOne({ _id: new ObjectId(id) });
    if (!cake) return res.status(404).json({ error: 'Cake not found' });

    return res.json(cake);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch cake details' });
  }
});

/**
 * @route   DELETE /api/cakes/:id
 */
app.delete('/api/cakes/:id', verifyToken, isAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const id = req.params.id as string;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid Cake ID format' });

    const currentDb = getDB();
    const result = await currentDb.collection('cakes').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Cake not found' });

    return res.json({ message: 'Cake item deleted successfully' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete cake item' });
  }
});

/**
 * @route   POST /api/orders
 */
app.post('/api/orders', verifyToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, items, deliveryAddress, phoneNumber } = req.body;

    if (!items || items.length === 0) return res.status(400).json({ error: 'Cart is empty.' });
    if (!userId || !deliveryAddress || !phoneNumber) return res.status(400).json({ error: 'Missing properties.' });

    const newOrder: IOrder = {
      userId,
      items: items.map((item: any) => ({
        ...item,
        priceOrPriority: Number(item.priceOrPriority) // সেফটি পার্সিং
      })),
      deliveryAddress,
      phoneNumber,
      status: 'Pending',
      createdAt: new Date()
    };

    const currentDb = getDB();
    const result = await currentDb.collection<IOrder>('orders').insertOne(newOrder);
    return res.status(201).json({ _id: result.insertedId, ...newOrder });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to place order' });
  }
});

/**
 * @route   POST /api/cart
 */
app.post('/api/cart', verifyToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, cakeId, quantity } = req.body;
    if (!userId || !cakeId) return res.status(400).json({ error: 'Missing userId or cakeId' });

    const itemQuantity = quantity ? parseInt(quantity) : 1;
    const currentDb = getDB();
    const existingItem = await currentDb.collection('cart').findOne({ userId, cakeId });

    if (existingItem) {
      await currentDb.collection('cart').updateOne({ userId, cakeId }, { $inc: { quantity: itemQuantity } });
      return res.status(200).json({ message: 'Cart item quantity updated' });
    } else {
      const newCartItem = { userId, cakeId, quantity: itemQuantity, addedAt: new Date() };
      await currentDb.collection('cart').insertOne(newCartItem);
      return res.status(201).json({ message: 'Added to cart successfully', data: newCartItem });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Failed to add item to cart' });
  }
});

/**
 * @route   POST /api/wishlist/toggle
 */
app.post('/api/wishlist/toggle', verifyToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, cakeId } = req.body;
    if (!userId || !cakeId) return res.status(400).json({ error: 'Missing userId or cakeId' });

    const currentDb = getDB();
    const existingWish = await currentDb.collection('wishlist').findOne({ userId, cakeId });

    if (existingWish) {
      await currentDb.collection('wishlist').deleteOne({ userId, cakeId });
      return res.status(200).json({ isSaved: false, message: 'Item removed from wishlist' });
    } else {
      const newWish = { userId, cakeId, savedAt: new Date() };
      await currentDb.collection('wishlist').insertOne(newWish);
      return res.status(201).json({ isSaved: true, message: 'Item saved to wishlist' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Failed to toggle wishlist item' });
  }
});

/**
 * @route   GET /api/wishlist/:userId
 */
app.get('/api/wishlist/:userId', verifyToken, async (req: Request, res: Response): Promise<any> => {
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
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch wishlist items' });
  }
});

/**
 * @route   GET /api/cart/:userId
 */
app.get('/api/cart/:userId', verifyToken, async (req: Request, res: Response): Promise<any> => {
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
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch cart items' });
  }
});

/**
 * @route   DELETE /api/cart/clear/:userId
 */
app.delete('/api/cart/clear/:userId', verifyToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const currentDb = getDB();
    await currentDb.collection('cart').deleteMany({ userId });
    return res.json({ message: 'Cart cleared successfully' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to clear cart' });
  }
});

/**
 * @route   DELETE /api/cart/:userId/:cakeId
 */
app.delete('/api/cart/:userId/:cakeId', verifyToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, cakeId } = req.params;
    const currentDb = getDB();
    const result = await currentDb.collection('cart').deleteOne({ userId, cakeId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Cart item not found' });
    return res.json({ message: 'Item removed from cart' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to remove cart item' });
  }
});

/**
 * @route   GET /api/cart/count/:userId
 * @desc    ইউজারের কার্টের মোট আইটেম সংখ্যা
 */
app.get('/api/cart/count/:userId', verifyToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const currentDb = getDB();
    const count = await currentDb.collection('cart').countDocuments({ userId });
    return res.json({ count });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to count cart items' });
  }
});

// ==================== ADMIN ORDER MANAGEMENT ROUTES ====================

/**
 * @route   GET /api/admin/orders
 * @desc    সব গ্রাহকের অর্ডার হিস্টোরি দেখা (শুধুমাত্র অ্যাডমিন)
 */
app.get('/api/admin/orders', verifyToken, isAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const currentDb = getDB();
    const orders = await currentDb.collection<IOrder>('orders')
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    return res.json(orders);
  } catch (error) {
    console.error('Error fetching admin orders:', error);
    return res.status(500).json({ error: 'Failed to fetch all orders' });
  }
});

/**
 * @route   PATCH /api/admin/orders/:orderId/status
 * @desc    অর্ডারের স্ট্যাটাস মডিফাই করা (FIXED for MongoDB v6+)
 */
app.patch('/api/admin/orders/:orderId/status', verifyToken, isAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(orderId as string)) {
      return res.status(400).json({ error: 'Invalid Order ID format' });
    }

    const validStatuses: IOrder['status'][] = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const currentDb = getDB();

    // টাইপ সেফটি নিশ্চিত করতে এবং টাইপস্ক্রিপ্ট এরর এড়াতে টাইপ কাস্টিং করা হয়েছে
    const updatedOrder = await currentDb.collection('orders').findOneAndUpdate(
      { _id: new ObjectId(orderId as string) },
      { $set: { status: status as IOrder['status'] } },
      { returnDocument: 'after' }
    ) as IOrder | null; // এখানে টাইপ কাস্ট করে দেওয়া হলো

    if (!updatedOrder) {
      return res.status(404).json({ error: 'Order not found to update' });
    }

    return res.json(updatedOrder);
  } catch (error) {
    console.error('Error updating order status:', error);
    return res.status(500).json({ error: 'Failed to update order status' });
  }
});

/**
 * @route   GET /api/orders/:userId
 * @desc    নির্দিষ্ট কাস্টমারের অর্ডার হিস্টোরি
 */
app.get('/api/orders/:userId', verifyToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const currentDb = getDB();
    const orders = await currentDb.collection<IOrder>('orders')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json(orders);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * @route   POST /api/ai/generate-cake-details
 * @desc    Gemini AI দিয়ে কেকের বিস্তারিত বর্ণনা ও ট্যাগ জেনারেট করা
 */
app.post('/api/ai/generate-cake-details', async (req: Request, res: Response): Promise<any> => {
  try {
    const { title, category, length: outputLength } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: 'Missing required fields: title and category' });
    }

    if (typeof title !== 'string' || typeof category !== 'string') {
      return res.status(400).json({ error: 'title and category must be strings' });
    }

    const validLengths = ['short', 'medium', 'long'] as const;
    const length = validLengths.includes(outputLength) ? outputLength : 'medium';

    const lengthInstructions: Record<string, string> = {
      short: 'Write a concise 1-paragraph description (2-3 sentences).',
      medium: 'Write a detailed 2-paragraph description.',
      long: 'Write an extensive 3-4 paragraph description with rich detail about flavors, texture, appearance, pairings, and ideal occasions.',
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured' });
    }

    const prompt = `You are a professional pastry chef and bakery copywriter. Always respond with valid JSON only.

Generate a professional cake description and tags for a cake with the following details:

Title: "${title}"
Category: "${category}"
Output Length: ${length}

${lengthInstructions[length]}

You MUST respond with ONLY valid JSON in this exact format:
{
  "fullDescription": "A professional, engaging description that describes the cake's likely flavors, appearance, texture, and ideal occasions. Never use placeholder or lorem ipsum text.",
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

    let geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
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
      geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: retryController.signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      clearTimeout(retryTimeout);
    }

    if (!geminiRes.ok) {
      const rawErr = await geminiRes.text();
      console.error(`❌ Gemini generate error [${geminiRes.status}]:`, rawErr.slice(0, 500));
      const status = geminiRes.status;

      if (status === 400 || status === 403 || status === 404) {
        return res.status(500).json({ error: 'AI service configuration issue. Please contact the administrator.' });
      }

      if (status === 429 || status === 503) {
        console.warn('Gemini rate-limited or unavailable. Returning fallback data.');
        return res.status(200).json(fallback());
      }

      return res.status(500).json({ error: rawErr || 'Failed to generate cake details' });
    }

    const geminiData: any = await geminiRes.json();
    const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const cleaned = responseText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

    let parsed: AIGeneratedCakeDetails;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: responseText });
    }

    if (!parsed.fullDescription || typeof parsed.fullDescription !== 'string') {
      return res.status(500).json({ error: 'AI response missing fullDescription' });
    }

    if (!Array.isArray(parsed.tags) || parsed.tags.length !== 4 || !parsed.tags.every(t => typeof t === 'string')) {
      return res.status(500).json({ error: 'AI response must contain exactly 4 string tags' });
    }

    return res.json(parsed);
  } catch (error: any) {
    console.error('Gemini API Error:', JSON.stringify({ message: error?.message, stack: error?.stack?.split('\n')[0] }));
    return res.status(500).json({
      error: error?.message || 'Failed to generate cake details',
    });
  }
});

/**
 * @route   POST /api/ai/chat
 * @desc    AI Chat Assistant — conversational bakery assistant with context
 */
app.post('/api/ai/chat', async (req: Request, res: Response): Promise<any> => {
  try {
    const { messages, userId } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured' });
    }

    // Fetch expanded project context from the database
    let bakeryContext = 'No menu data available.';
    let categoriesList: string[] = [];
    let userInfo = '';
    let userOrders = '';
    let userCart = '';
    let userWishlist = '';

    try {
      const currentDb = getDB();

      const cakes = await currentDb.collection('cakes')
        .find({}, { projection: { title: 1, category: 1, priceOrPriority: 1, tags: 1 } })
        .limit(20)
        .toArray();
      if (cakes.length > 0) {
        bakeryContext = cakes.map(c =>
          `- ${c.title} ($${c.priceOrPriority}) [${c.category}]`
        ).join('\n');
      }

      const categories = await currentDb.collection('cakes').distinct('category');
      categoriesList = categories.filter(Boolean) as string[];

      if (userId) {
        const user = await currentDb.collection('user').findOne(
          { _id: new ObjectId(userId) },
          { projection: { name: 1, email: 1, role: 1 } }
        );
        if (user) {
          userInfo = `Name: ${user.name}, Email: ${user.email}, Role: ${user.role}`;
        }

        const orders = await currentDb.collection('orders')
          .find({ userId })
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();
        if (orders.length > 0) {
          userOrders = orders.map((o: any) =>
            `Order #${o._id}: ${o.items?.length || 0} items, Status: ${o.status}`
          ).join('\n');
        }

        const cartCount = await currentDb.collection('cart').countDocuments({ userId });
        userCart = cartCount > 0 ? `${cartCount} items in cart` : 'Cart is empty';

        const wishlistCount = await currentDb.collection('wishlist').countDocuments({ userId });
        userWishlist = wishlistCount > 0 ? `${wishlistCount} saved items` : 'No saved items';
      }
    } catch { /* no-op — use fallback context */ }

    // Build conversation history and find latest question
    const conversationText = messages.map((m: any) => {
      const label = m.role === 'assistant' ? 'Assistant' : 'Customer';
      return `${label}: ${m.content}`;
    }).join('\n');

    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user');
    const latestQuestion = lastUserMsg?.content || '';
    const allUserText = messages.filter((m: any) => m.role === 'user').map((m: any) => m.content.toLowerCase()).join(' ');

    // Smart fallback with expanded project context
    const chatFallback = (): { reply: string; suggestions: string[] } => {
      const q = latestQuestion.toLowerCase();
      const allQ = allUserText;
      const categories = categoriesList.length > 0 ? categoriesList.join(', ') : 'Cakes, Cupcakes, Pastries';

      if (userId && (q.includes('my') || q.includes('me') || q.includes('i '))) {
        if (q.includes('order') || allQ.includes('order')) {
          return {
            reply: userOrders
              ? `Here are your recent orders:\n${userOrders}\n\nYou can view full details in your Dashboard.`
              : "You don't have any orders yet. Browse our Products page to place your first order!",
            suggestions: ["How do I place an order?", "What's on your menu?", "Show me best-sellers"]
          };
        }
        if (q.includes('cart')) {
          return {
            reply: `You have ${userCart}. Visit your Dashboard to manage your cart and checkout!`,
            suggestions: ["What's in my cart?", "How do I checkout?", "Show me products"]
          };
        }
        if (q.includes('wishlist') || q.includes('saved') || q.includes('favorite')) {
          return {
            reply: `You have ${userWishlist}. You can manage your wishlist from the product pages!`,
            suggestions: ["Browse products", "What's popular?", "Add to cart"]
          };
        }
        if (q.includes('account') || q.includes('profile') || q.includes('info')) {
          return {
            reply: userInfo ? `Here's your account info:\n${userInfo}` : "Please log in to view your account details.",
            suggestions: ["My orders", "My cart", "Browse products"]
          };
        }
        if (q.includes('dashboard') || q.includes('panel') || q.includes('admin')) {
          return {
            reply: "You can access your Dashboard from the navigation bar. There you can manage orders, your cart, and account settings.",
            suggestions: ["My orders", "My cart", "Account settings"]
          };
        }
      }

      if (q.includes('cake') || q.includes('menu') || q.includes('browse') || q.includes('have') || q.includes('product') || q.includes('offer') || q.includes('sell')) {
        return {
          reply: bakeryContext.startsWith('-')
            ? `Here's what we have right now:\n${bakeryContext.split('\n').slice(0, 6).join('\n')}\n\nWe also have ${categories}. What would you like to know more about?`
            : `We offer a wonderful selection including ${categories}. What sounds interesting to you?`,
          suggestions: ["Tell me about your cakes", "What's the price range?", "Do you have custom orders?"]
        };
      }

      if (q.includes('price') || q.includes('cost') || q.includes('much') || q.includes('expensive') || q.includes('cheap') || q.includes('budget') || q.includes('afford') || q.includes('spend')) {
        return {
          reply: "Our prices vary by item — most Celebration Cakes range from $25-$60, Cupcakes start at $3 each, Cookies at $2, and Artisan Breads start at $6. Visit our Products page to see the full menu with prices!",
          suggestions: ["What's your most popular cake?", "Do you have any deals?", "Can I customize a cake?"]
        };
      }

      if (q.includes('order') || q.includes('delivery') || q.includes('shipp') || q.includes('deliver') || q.includes('buy') || q.includes('purchase') || q.includes('checkout') || q.includes('pay') || q.includes('place')) {
        return {
          reply: userId
            ? `To place an order, browse our Products, add items to your cart, and checkout. ${userOrders ? `\n\nYou currently have orders: ${userOrders.split('\n').length} order(s).` : ''}`
            : "Please sign in first to place orders! Once logged in, browse our Products page, add items to cart, and proceed to checkout.",
          suggestions: ["How do I track my order?", "What's your return policy?", "Do you offer local pickup?"]
        };
      }

      if (q.includes('recommend') || q.includes('suggest') || q.includes('popular') || q.includes('best') || q.includes('favorite') || q.includes('top') || q.includes('bestseller') || q.includes('trend')) {
        return {
          reply: "Our Celebration Cakes are customer favorites — perfect for birthdays and special occasions! The Velvet Rose Gateau and Chocolate Dream Cake are top sellers. For something lighter, our Croissants and Cupcakes are always a hit!",
          suggestions: ["What cake is good for a birthday?", "Do you have eggless options?", "What's new this season?"]
        };
      }

      if (q.includes('birthday') || q.includes('anniversary') || q.includes('wedding') || q.includes('event') || q.includes('party') || q.includes('celebration') || q.includes('occasion')) {
        return {
          reply: "Our Celebration Cakes category is perfect for any occasion! Beautifully decorated cakes for birthdays, anniversaries, and weddings. Check our Seasonal Specials too. Each cake can be customized!",
          suggestions: ["Can I customize the design?", "How far in advance should I order?", "Do you have cake tasting?"]
        };
      }

      if (q.includes('ingredient') || q.includes('vegan') || q.includes('gluten') || q.includes('allerg') || q.includes('eggless') || q.includes('dairy') || q.includes('nut') || q.includes('diet') || q.includes('healthy')) {
        return {
          reply: "We take dietary needs seriously! Many items can be made eggless or with alternative ingredients. Check product descriptions or contact us for custom dietary requirements.",
          suggestions: ["Do you have gluten-free options?", "Are your cakes nut-free?", "What vegan options do you have?"]
        };
      }

      if (q.includes('contact') || q.includes('phone') || q.includes('email') || q.includes('call') || q.includes('reach') || q.includes('support') || q.includes('help') || q.includes('location') || q.includes('address') || q.includes('open') || q.includes('hour') || q.includes('store')) {
        return {
          reply: "You can reach us through our Contact page, or visit your Dashboard to manage orders and account settings. We're always here to help!",
          suggestions: ["I have a question about my order", "Where are you located?", "Can I speak to a person?"]
        };
      }

      if (q.includes('hello') || q.includes('hi ') || q.includes('hey') || q.includes('good morning') || q.includes('good evening') || q.includes('greeting') || q.includes('howdy') || q.includes('yo') || q.includes('whatsup') || q.includes('sup')) {
        return {
          reply: `Hey there! Welcome to SweetByte Bakery! 🧁 I'm your bakery assistant.${userId ? ` Great to see you again!` : ''} Looking for a delicious cake or a sweet treat? Let me know how I can help!`,
          suggestions: ["What cakes do you have?", "I need help choosing", "Show me your best-sellers"]
        };
      }

      if (q.includes('chocolate') || q.includes('vanilla') || q.includes('strawberry') || q.includes('red velvet') || q.includes('caramel') || q.includes('coffee') || q.includes('fruit') || q.includes('berry') || q.includes('cream') || q.includes('cheesecake') || q.includes('flavor')) {
        return {
          reply: "Great flavor choices! We have a variety of cakes in chocolate, vanilla, red velvet, and fruit flavors. Check our Products page to see the full selection with descriptions!",
          suggestions: ["What chocolate options do you have?", "Do you have fruit cakes?", "Can I mix flavors?"]
        };
      }

      return {
        reply: `Thanks for reaching out to SweetByte Bakery! We have a wonderful selection of ${categories}. What would you like to know more about?`,
        suggestions: ["What cakes do you recommend?", "Tell me about your menu", "How do I place an order?"]
      };
    };

    const prompt = `You are a friendly and knowledgeable bakery assistant for "SweetByte Bakery". You help customers with questions about cakes, bakery items, orders, and bakery-related topics.

Here is our current menu:
${bakeryContext}

Available categories: ${categoriesList.join(', ') || 'Cakes, Cupcakes, Pastries, Cookies'}

${userId ? `Customer info:\n${userInfo || 'Logged in'}\nOrders:\n${userOrders || 'No orders yet'}\nCart: ${userCart}\nWishlist: ${userWishlist}` : 'Customer is not logged in.'}

Guidelines:
- Answer questions based on our menu. If something is not on the menu, suggest the closest alternative.
- Keep responses warm, enthusiastic, and concise (2-4 sentences).
- If asked about order status, delivery, or account issues, check the customer info above. If they have orders, answer based on that data.
- If you don't know something, say so honestly.

Conversation so far:
${conversationText}

Now respond to the customer's latest question. Keep it warm and helpful. Then on a new line, suggest 3 short follow-up questions the customer might ask next, each on its own line starting with "Q:".`;

    // Use the same proven single-content format as generate-cake-details
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    clearTimeout(timeout);

    // Retry once on 503 (same as generate-cake-details)
    if (geminiRes.status === 503) {
      console.warn('Gemini chat 503. Retrying once after 1s...');
      await new Promise(r => setTimeout(r, 1000));
      const retryController = new AbortController();
      const retryTimeout = setTimeout(() => retryController.abort(), 20000);
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: retryController.signal,
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );
      clearTimeout(retryTimeout);
    }

    if (!geminiRes.ok) {
      const rawErr = await geminiRes.text();
      const status = geminiRes.status;
      console.error(`❌ Gemini chat error [${status}]:`, rawErr.slice(0, 500));

      if (status === 400 || status === 403 || status === 404) {
        return res.status(200).json({
          reply: "Our AI assistant is temporarily unavailable. Please try again later!",
          suggestions: ["Browse our products", "Check our menu", "Contact us directly"]
        });
      }

      if (status === 429 || status === 503) {
        console.warn('Gemini quota exceeded. Returning smart fallback.');
        return res.status(200).json(chatFallback());
      }

      return res.status(500).json({ error: rawErr || 'Failed to get AI response' });
    }

    const geminiData: any = await geminiRes.json();
    const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!responseText) {
      return res.status(200).json({
        reply: "I'm sorry, I couldn't process that. Could you rephrase your question?",
        suggestions: ["Show me your cake menu", "What's popular today?", "I need help choosing a cake"]
      });
    }

    // Parse the reply and suggestions from the response
    // Format expected: reply text followed by lines starting with "Q:"
    const lines = responseText.split('\n').map((l: string) => l.trim()).filter(Boolean);
    const qLines: string[] = [];
    const replyLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('Q:') || line.startsWith('q:')) {
        qLines.push(line.replace(/^Q:\s*/i, ''));
      } else {
        replyLines.push(line);
      }
    }

    const reply = replyLines.join('\n');
    const suggestions = qLines.length >= 2
      ? qLines.slice(0, 3)
      : [
          "What cakes do you recommend?",
          "Tell me about your best-sellers",
          "Can you suggest a cake for a birthday?"
        ];

    return res.json({ reply, suggestions });
  } catch (error: any) {
    console.error('AI Chat Error:', error?.message);
    return res.status(500).json({
      reply: "Sorry, I'm having trouble connecting right now. Please try again.",
      suggestions: ["What cakes do you have?", "How do I place an order?", "Contact support"]
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

export default app;