import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// Get reviews for a product (PUBLIC - no auth needed)
router.get("/product/:productId", async (req, res) => {
  try {
    const { productId } = req.params;
    const { shop, page = 1, limit = 10, sort = "newest" } = req.query;

    const orderBy = {
      newest: { createdAt: "desc" },
      oldest: { createdAt: "asc" },
      highest: { rating: "desc" },
      lowest: { rating: "asc" },
      helpful: { helpfulCount: "desc" }
    }[sort] || { createdAt: "desc" };

    const reviews = await prisma.review.findMany({
      where: { shop, productId, published: true },
      orderBy,
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    });

    const total = await prisma.review.count({
      where: { shop, productId, published: true }
    });

    const avgResult = await prisma.review.aggregate({
      where: { shop, productId, published: true },
      _avg: { rating: true }
    });

    const stats = await prisma.review.groupBy({
      by: ["rating"],
      where: { shop, productId, published: true },
      _count: { rating: true }
    });

    res.json({
      reviews,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      },
      stats: {
        average: Math.round((avgResult._avg.rating || 0) * 10) / 10,
        total,
        breakdown: stats.reduce((acc, s) => {
          acc[s.rating] = s._count;
          return acc;
        }, {})
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit a review (PUBLIC)
router.post("/submit", async (req, res) => {
  try {
    const { shop, productId, customerName, customerEmail, rating, title, body, photos = [], orderId } = req.body;

    let verified = false;
    if (orderId) {
      const order = await prisma.reviewRequest.findFirst({
        where: { orderId, customerEmail, shop }
      });
      if (order) {
        verified = true;
        await prisma.reviewRequest.update({
          where: { id: order.id },
          data: { status: "reviewed", reviewedAt: new Date() }
        });
      }
    }

    const settings = await prisma.storeSettings.findUnique({ where: { shop } });
    const published = settings?.autoPublish ?? true;

    const review = await prisma.review.create({
      data: {
        shop,
        productId,
        customerName,
        customerEmail,
        rating: parseInt(rating),
        title,
        body,
        photos,
        verified,
        published,
        orderId,
        sessionId: "public"
      }
    });

    res.status(201).json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark helpful
router.post("/:id/helpful", async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const review = await prisma.review.update({
      where: { id },
      data: { helpfulCount: { [action === "increment" ? "increment" : "decrement"]: 1 } }
    });

    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ROUTES - require shop header
router.get("/admin/all", async (req, res) => {
  try {
    const { shop } = req.query;
    const { status, page = 1, limit = 20, search } = req.query;

    const where = { shop };
    if (status === "published") where.published = true;
    if (status === "pending") where.published = false;
    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: "insensitive" } },
        { body: { contains: search, mode: "insensitive" } },
        { productTitle: { contains: search, mode: "insensitive" } }
      ];
    }

    const reviews = await prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    });

    const total = await prisma.review.count({ where });

    res.json({
      reviews,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/admin/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { published, featured, reply } = req.body;

    const data = {};
    if (published !== undefined) data.published = published;
    if (featured !== undefined) data.featured = featured;
    if (reply !== undefined) {
      data.reply = reply;
      data.replyDate = reply ? new Date() : null;
    }

    const review = await prisma.review.update({ where: { id }, data });
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/admin/:id", async (req, res) => {
  try {
    await prisma.review.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/admin/bulk", async (req, res) => {
  try {
    const { ids, action } = req.body;

    switch (action) {
      case "publish":
        await prisma.review.updateMany({ where: { id: { in: ids } }, data: { published: true } });
        break;
      case "unpublish":
        await prisma.review.updateMany({ where: { id: { in: ids } }, data: { published: false } });
        break;
      case "feature":
        await prisma.review.updateMany({ where: { id: { in: ids } }, data: { featured: true } });
        break;
      case "delete":
        await prisma.review.deleteMany({ where: { id: { in: ids } } });
        break;
    }

    res.json({ success: true, affected: ids.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;