import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ObjectId, Db } from 'mongodb';

// ==================== TYPE INTERFACES (DATA STRUCTURE) ====================
export interface ICake {
  _id?: ObjectId;
  title: string;
  imageUrl: string; 
  priceOrPriority: number | string;
  category: string;
  userId: string;
  fullDescription: string;
  tags: string[];
  createdAt: Date;
}

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

app.use(cors({
  origin: 'http://localhost:3000', 
  credentials: true,               
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'] 
}));

app.use(express.json());

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = 'sweetbyte-ai';
let db: Db;

// ডেটাবেজ রেডি আছে কিনা তা নিশ্চিত করার সেফটি ফাংশন
const getDB = (): Db => {
  if (!db) {
    throw new Error('Database not initialized yet');
  }
  return db;
};

// ডাটাবেজ কানেকশন এবং সার্ভার স্টার্ট
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

// ==================== MIDDLEWARE ====================
const isAdmin = async (req: Request, res: Response, next: any): Promise<any> => {
  try {
    const userId = req.headers['x-user-id']; 

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized. User session not found.' });
    }

    if (!ObjectId.isValid(userId as string)) {
      return res.status(400).json({ error: 'Invalid User ID format in headers.' });
    }

    const currentDb = getDB();
    const user = await currentDb.collection('user').findOne({ _id: new ObjectId(userId as string) });

    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden. Admin access required.' });
    }

    next(); 
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
 * @desc    নতুন কেক আইটেম যোগ করা (শুধুমাত্র অ্যাডমিন)
 */
app.post('/api/cakes', isAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { title, imageUrl, priceOrPriority, category, userId, fullDescription, tags } = req.body;

    if (!title || !imageUrl || !priceOrPriority || !category || !userId) {
      return res.status(400).json({ error: 'Missing required fields to add a cake' });
    }

    const newCake: ICake = {
      title,
      imageUrl, 
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
 * @desc    সার্চ ও ফিল্টারসহ সব কেক আনা
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
    const id = req.params.id as string;
    
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
 * @desc    নির্দিষ্ট কেক ডিলিট করা (শুধুমাত্র অ্যাডমিন)
 */
app.delete('/api/cakes/:id', isAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const id = req.params.id as string;

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
 * @desc    جدুন কাস্টমার অর্ডার তৈরি করা
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

/**
 * @route   POST /api/cart
 * @desc    কার্টে কেক আইটেম যোগ করা বা কোয়ান্টিটি আপডেট করা
 */
app.post('/api/cart', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, cakeId, quantity } = req.body;

    if (!userId || !cakeId) {
      return res.status(400).json({ error: 'Missing userId or cakeId' });
    }

    const itemQuantity = quantity ? parseInt(quantity) : 1;
    const currentDb = getDB();

    const existingItem = await currentDb.collection('cart').findOne({ userId, cakeId });

    if (existingItem) {
      await currentDb.collection('cart').updateOne(
        { userId, cakeId },
        { $inc: { quantity: itemQuantity } }
      );
      return res.status(200).json({ message: 'Cart item quantity updated' });
    } else {
      const newCartItem = {
        userId,
        cakeId,
        quantity: itemQuantity,
        addedAt: new Date()
      };
      await currentDb.collection('cart').insertOne(newCartItem);
      return res.status(201).json({ message: 'Item added to cart successfully', data: newCartItem });
    }
  } catch (error) {
    console.error('Error adding to cart:', error);
    return res.status(500).json({ error: 'Failed to add item to cart' });
  }
});

/**
 * @route   POST /api/wishlist/toggle
 * @desc    কেক আইটেম উইশলিস্টে যোগ বা রিমুভ করা (Toggle)
 */
app.post('/api/wishlist/toggle', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, cakeId } = req.body;

    if (!userId || !cakeId) {
      return res.status(400).json({ error: 'Missing userId or cakeId' });
    }

    const currentDb = getDB();
    const existingWish = await currentDb.collection('wishlist').findOne({ userId, cakeId });

    if (existingWish) {
      await currentDb.collection('wishlist').deleteOne({ userId, cakeId });
      return res.status(200).json({ isSaved: false, message: 'Item removed from wishlist' });
    } else {
      const newWish = {
        userId,
        cakeId,
        savedAt: new Date()
      };
      await currentDb.collection('wishlist').insertOne(newWish);
      return res.status(201).json({ isSaved: true, message: 'Item saved to wishlist' });
    }
  } catch (error) {
    console.error('Error toggling wishlist:', error);
    return res.status(500).json({ error: 'Failed to toggle wishlist item' });
  }
});

/**
 * @route   GET /api/cart/count/:userId
 * @desc    ইউজারের কার্টের মোট আইটেম সংখ্যা গণনা করা
 */
app.get('/api/cart/count/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const currentDb = getDB();
    const count = await currentDb.collection('cart').countDocuments({ userId });
    return res.json({ count });
  } catch (error) {
    console.error('Error counting cart items:', error);
    return res.status(500).json({ error: 'Failed to count cart items' });
  }
});

/**
 * @route   GET /api/cart/:userId
 * @desc    ইউজারের কার্টের সব আইটেম কেক ডিটেইলস সহ ফেরত দেওয়া
 */
app.get('/api/cart/:userId', async (req: Request, res: Response): Promise<any> => {
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
    console.error('Error fetching cart items:', error);
    return res.status(500).json({ error: 'Failed to fetch cart items' });
  }
});

/**
 * @route   GET /api/wishlist/:userId
 * @desc    ইউজারের উইশলিস্টের সব আইটেম কেক ডিটেইলস সহ ফেরত দেওয়া
 */
app.get('/api/wishlist/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const currentDb = getDB();

    const wishlistItems = await currentDb.collection('wishlist').aggregate([
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

    return res.json(wishlistItems);
  } catch (error) {
    console.error('Error fetching wishlist items:', error);
    return res.status(500).json({ error: 'Failed to fetch wishlist items' });
  }
});

/**
 * @route   DELETE /api/wishlist/:userId/:cakeId
 * @desc    উইশলিস্ট থেকে নির্দিষ্ট আইটেম রিমুভ করা
 */
app.delete('/api/wishlist/:userId/:cakeId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, cakeId } = req.params;
    const currentDb = getDB();
    await currentDb.collection('wishlist').deleteOne({ userId, cakeId });
    return res.json({ isSaved: false, message: 'Removed from wishlist' });
  } catch (error) {
    console.error('Error removing from wishlist:', error);
    return res.status(500).json({ error: 'Failed to remove wishlist item' });
  }
});

/**
 * @route   DELETE /api/cart/clear/:userId
 * @desc    ইউজারের পুরো কার্ট খালি করা (অর্ডার সফল হলে)
 */
app.delete('/api/cart/clear/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const currentDb = getDB();
    await currentDb.collection('cart').deleteMany({ userId });
    return res.json({ message: 'Cart cleared successfully' });
  } catch (error) {
    console.error('Error clearing cart:', error);
    return res.status(500).json({ error: 'Failed to clear cart' });
  }
});

/**
 * @route   DELETE /api/cart/:userId/:cakeId
 * @desc    কার্ট থেকে নির্দিষ্ট একটি কেক আইটেম রিমুভ করা
 */
app.delete('/api/cart/:userId/:cakeId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, cakeId } = req.params;
    const currentDb = getDB();
    const result = await currentDb.collection('cart').deleteOne({ userId, cakeId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Cart item not found' });
    }
    return res.json({ message: 'Item removed from cart' });
  } catch (error) {
    console.error('Error removing cart item:', error);
    return res.status(500).json({ error: 'Failed to remove cart item' });
  }
});

/**
 * @route   GET /api/orders/user/:userId
 * @desc    ইউজারের সব অর্ডার হিস্টোরি ফেরত দেওয়া
 */
app.get('/api/orders/user/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const currentDb = getDB();
    const orders = await currentDb.collection<IOrder>('orders')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * @route   GET /api/orders/:userId
 * @desc    ইউজারের অর্ডার হিস্টোরি (শর্টহ্যান্ড রুট)
 */
app.get('/api/orders/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const currentDb = getDB();
    const orders = await currentDb.collection<IOrder>('orders')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});