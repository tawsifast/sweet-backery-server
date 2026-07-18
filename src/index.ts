import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ObjectId, Db } from 'mongodb';

// ==================== TYPE INTERFACES (DATA STRUCTURE) ====================
// ১. কেক আইটেমের জন্য ডাটা স্ট্রাকচার
export interface ICake {
  _id?: ObjectId;
  title: string;
  shortDescription: string;
  priceOrPriority: number | string;
  category: string;
  userId: string;
  fullDescription: string;
  tags: string[];
  createdAt: Date;
}

// ২. কাস্টমার অর্ডারের জন্য ডাটা স্ট্রাকচার
export interface IOrderItem {
  cakeId: string;
  title: string;
  priceOrPriority: number | string;
  quantity?: number;
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

// ==================== CONFIGURATIONS ====================
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors());
app.use(express.json());

// MongoDB URI & Name
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = 'sweetbyte-ai';

let db: Db;

// ডাটাবেজ কানেকশন এবং সার্ভার স্টার্ট
async function startServer() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('🔥 Native MongoDB Connected Successfully!');
    
    // কানেকশন হওয়ার পরেই কেবল এক্সপ্রেস রিকোয়েস্ট লিসেন করবে
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
  }
}

startServer();

// ডেটাবেজ রেডি আছে কিনা তা নিশ্চিত করার সেফটি ফাংশน
const getDB = (): Db => {
  if (!db) {
    throw new Error('Database not initialized yet');
  }
  return db;
};

// মিডলওয়্যার: শুধুমাত্র অ্যাডমিন অ্যাক্সেস নিশ্চিত করার জন্য
const isAdmin = async (req: Request, res: Response, next: any): Promise<any> => {
  try {
    const userId = req.headers['x-user-id']; // ফ্রন্টএন্ড থেকে পাঠানো ইউজারের আইডি

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized. User session not found.' });
    }

    // ভুল আইডি ফরম্যাট পাস করলে যেন এপিআই ক্র্যাশ না করে
    if (!ObjectId.isValid(userId as string)) {
      return res.status(400).json({ error: 'Invalid User ID format in headers.' });
    }

    const currentDb = getDB();
    // Better Auth সাধারণত একক 'user' কালেকশন ব্যবহার করে
    const user = await currentDb.collection('user').findOne({ _id: new ObjectId(userId as string) });

    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden. Admin access required.' });
    }

    next(); // ইউজার অ্যাডমিন হলে পরের ধাপে যাবে
  } catch (error) {
    console.error('Authorization Middleware Error:', error);
    return res.status(500).json({ error: 'Authorization check failed.' });
  }
};

// ==================== ALL API ROUTES ====================

/**
 * @route   GET /
 * @desc    সার্ভার স্ট্যাটাস চেক
 */
app.get('/', (req: Request, res: Response) => {
  res.send('SweetByte AI Backend is running perfectly with Native MongoDB Collections...');
});

/**
 * @route   POST /api/cakes
 * @desc    'cakes' কালেকশনে নতুন কেক আইটেম যোগ করা (শুধুমাত্র অ্যাডমিন পারবে)
 */
app.post('/api/cakes', isAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { title, shortDescription, priceOrPriority, category, userId, fullDescription, tags } = req.body;

    // রিকোয়ার্ড ফিল্ড ভ্যালিডেশন
    if (!title || !shortDescription || !priceOrPriority || !category || !userId) {
      return res.status(400).json({ error: 'Missing required fields to add a cake' });
    }

    // ইন্টারফেস মেনে নতুন অবজেক্ট তৈরি
    const newCake: ICake = {
      title,
      shortDescription,
      priceOrPriority,
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
 * @desc    'cakes' কালেকশন থেকে সার্চ ও ফিল্টারসহ সব কেক আনা (সবার জন্য উন্মুক্ত)
 */
app.get('/api/cakes', async (req: Request, res: Response): Promise<any> => {
  try {
    const { search, category } = req.query;
    let query: any = {};

    if (search) query.title = { $regex: search, $options: 'i' };
    if (category) query.category = category;

    const currentDb = getDB();
    const cakes = await currentDb.collection<ICake>('cakes')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
      
    return res.json(cakes);
  } catch (error) {
    console.error('Error fetching cakes:', error);
    return res.status(500).json({ error: 'Failed to fetch cakes' });
  }
});

/**
 * @route   GET /api/cakes/user/:userId
 * @desc    নির্দিষ্ট কোনো ইউজারের আপলোড করা কেকগুলো খুঁজে বের করা
 */
app.get('/api/cakes/user/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    
    const currentDb = getDB();
    const userCakes = await currentDb.collection<ICake>('cakes')
      .find({ userId: userId })
      .sort({ createdAt: -1 })
      .toArray();
    
    return res.json(userCakes);
  } catch (error) {
    console.error('Error fetching user cakes:', error);
    return res.status(500).json({ error: 'Failed to fetch user specific cakes' });
  }
});

/**
 * @route   GET /api/cakes/:id
 * @desc    আইডি দিয়ে নির্দিষ্ট একটি কেকের ডিটেইলস ডাটা আনা
 */
app.get('/api/cakes/:id', async (req: Request, res: Response): Promise<any> => {
  try {
    const { id } = req.params;
    
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid Cake ID format' });
    }

    const currentDb = getDB();
    const cake = await currentDb.collection<ICake>('cakes').findOne({ _id: new ObjectId(id) });
    if (!cake) return res.status(404).json({ error: 'Cake not found' });
    
    return res.json(cake);
  } catch (error) {
    console.error('Error fetching cake details:', error);
    return res.status(500).json({ error: 'Failed to fetch cake details' });
  }
});

/**
 * @route   DELETE /api/cakes/:id
 * @desc    'cakes' কালেকশন থেকে নির্দিষ্ট কেক ডিলিট করা (শুধুমাত্র অ্যাডমিন পারবে)
 */
app.delete('/api/cakes/:id', isAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid Cake ID format' });
    }

    const currentDb = getDB();
    const result = await currentDb.collection<ICake>('cakes').deleteOne({ _id: new ObjectId(id) });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Cake not found to delete' });
    }

    return res.json({ message: 'Cake item deleted successfully' });
  } catch (error) {
    console.error('Error deleting cake:', error);
    return res.status(500).json({ error: 'Failed to delete cake item' });
  }
});

/**
 * @route   POST /api/orders
 * @desc    'orders' কালেকশনে নতুন কাস্টমার অর্ডার তৈরি করা (কাস্টমার ও অ্যাডমিন সবাই পারবে)
 */
app.post('/api/orders', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, items, deliveryAddress, phoneNumber } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty. Cannot process order.' });
    }

    if (!userId || !deliveryAddress || !phoneNumber) {
      return res.status(400).json({ error: 'Missing required order placement properties.' });
    }

    // ইন্টারফেস মেনে নতুন অর্ডার অবজেক্ট তৈরি
    const newOrder: IOrder = {
      userId,
      items,
      deliveryAddress,
      phoneNumber,
      status: 'Pending',
      createdAt: new Date()
    };

    const currentDb = getDB();
    const result = await currentDb.collection<IOrder>('orders').insertOne(newOrder);
    
    return res.status(201).json({ _id: result.insertedId, ...newOrder });
  } catch (error) {
    console.error('Error creating order:', error);
    return res.status(500).json({ error: 'Failed to place order' });
  }
});