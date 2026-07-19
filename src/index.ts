import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ObjectId, Db, Filter } from 'mongodb';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
  origin: 'http://localhost:3000', 
  credentials: true,               
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'] 
}));

app.use(express.json());

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = 'sweetbyte-ai';
let db: Db;

const getDB = (): Db => {
  if (!db) {
    throw new Error('Database not initialized yet');
  }
  return db;
};

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

// ==================== SERVER INITIALIZATION ====================
async function startServer() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('🔥 Native MongoDB Connected Successfully!');
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
  }
}

startServer();

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
    
    // টাইপ সেফটি নিশ্চিত করতে এবং টাইপস্ক্রিপ্ট এরর এড়াতে টাইপ কাস্টিং করা হয়েছে
    const updatedOrder = await currentDb.collection('orders').findOneAndUpdate(
      { _id: new ObjectId(orderId as string) },
      { $set: { status: status as IOrder['status'] } },
      { returnDocument: 'after' }
    ) as IOrder | null; // এখানে টাইপ কাস্ট করে দেওয়া হলো

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

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.1-flash-lite',
      systemInstruction: 'You are a professional pastry chef and bakery copywriter. Always respond with valid JSON only.'
    });

    const prompt = `Generate a professional cake description and tags for a cake with the following details:

Title: "${title}"
Category: "${category}"

You MUST respond with ONLY valid JSON (no markdown, no code blocks, no extra text) in this exact format:
{
  "fullDescription": "A professional, engaging description (2-3 paragraphs) that describes the cake's likely flavors, appearance, texture, and ideal occasions. Never use placeholder or lorem ipsum text.",
  "tags": ["tag1", "tag2", "tag3", "tag4"]
}

Requirements:
- fullDescription must be unique, compelling, and specific to this cake title and category
- fullDescription must NOT contain any placeholder or dummy text
- tags array must contain exactly 4 relevant, searchable tags
- Tags should be single words or short phrases (e.g. "chocolate", "birthday", "eggless")`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

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
    console.error('Gemini API Error:', error);

    if (error?.status === 429 || error?.message?.includes('quota') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({
        error: 'AI service quota exceeded. Please try again later or check your API billing.',
      });
    }

    if (error?.status === 404 || error?.message?.includes('not found')) {
      return res.status(500).json({
        error: 'AI model unavailable. Please contact the administrator.',
      });
    }

    return res.status(500).json({
      error: error?.message || 'Failed to generate cake details',
    });
  }
});