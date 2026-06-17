import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// Get dashboard analytics
router.get("/dashboard", async (req, res) => {
  try {
    const { shop, period = "30" } = req.query;
    const days = parseInt(period);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Total reviews
    const totalReviews = await prisma.review.count({ where: { shop } });
    const publishedReviews = await prisma.review.count({ where: { shop, published: true } });
    const pendingReviews = await prisma.review.count({ where: { shop, published: false } });

    // Average rating
    const avgResult = await prisma.review.aggregate({
      where: { shop, published: true },
      _avg: { rating: true }
    });

    // Rating distribution
    const ratingDist = await prisma.review.groupBy({
      by: ["rating"],
      where: { shop, published: true },
      _count: { rating: true }
    });

    // Recent activity
    const recentReviews = await prisma.review.findMany({
      where: { shop, createdAt: { gte: startDate } },
      orderBy: { createdAt: "desc" },
      take: 10
    });

    // Request stats
    const totalRequests = await prisma.reviewRequest.count({ where: { shop } });
    const sentRequests = await prisma.reviewRequest.count({ where: { shop, status: "sent" } });
    const reviewedRequests = await prisma.reviewRequest.count({ where: { shop, status: "reviewed" } });

    // Conversion rate
    const conversionRate = sentRequests > 0 ? (reviewedRequests / sentRequests * 100).toFixed(1) : 0;

    // Top products
    const topProducts = await prisma.review.groupBy({
      by: ["productId", "productTitle"],
      where: { shop, published: true },
      _count: { productId: true },
      _avg: { rating: true },
      orderBy: { _count: { productId: "desc" } },
      take: 10
    });

    res.json({
      overview: {
        totalReviews,
        publishedReviews,
        pendingReviews,
        averageRating: Math.round((avgResult._avg.rating || 0) * 10) / 10,
        totalRequests,
        conversionRate: `${conversionRate}%`
      },
      ratingDistribution: ratingDist.reduce((acc, r) => {
        acc[r.rating] = r._count;
        return acc;
      }, {}),
      recentActivity: recentReviews,
      topProducts: topProducts.map(p => ({
        productId: p.productId,
        productTitle: p.productTitle,
        reviewCount: p._count.productId,
        averageRating: Math.round((p._avg.rating || 0) * 10) / 10
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get daily stats for charts
router.get("/timeline", async (req, res) => {
  try {
    const { shop, days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const reviews = await prisma.review.groupBy({
      by: ["createdAt"],
      where: { shop, createdAt: { gte: startDate } },
      _count: { id: true },
      _avg: { rating: true }
    });

    res.json({ timeline: reviews });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;