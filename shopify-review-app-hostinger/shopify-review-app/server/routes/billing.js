import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// Plan definitions with limits
const PLANS = {
  free: {
    name: "Free",
    price: 0,
    reviewRequests: 50,
    reviews: 100,
    photos: false,
    videos: false,
    qna: false,
    imports: false,
    analytics: false,
    branding: true,
    support: "community"
  },
  starter: {
    name: "Starter",
    price: 9.99,
    reviewRequests: 500,
    reviews: 1000,
    photos: true,
    videos: false,
    qna: true,
    imports: true,
    analytics: true,
    branding: false,
    support: "email"
  },
  growth: {
    name: "Growth",
    price: 29.99,
    reviewRequests: 2000,
    reviews: 5000,
    photos: true,
    videos: true,
    qna: true,
    imports: true,
    analytics: true,
    branding: false,
    support: "priority"
  },
  pro: {
    name: "Pro",
    price: 79.99,
    reviewRequests: 10000,
    reviews: "unlimited",
    photos: true,
    videos: true,
    qna: true,
    imports: true,
    analytics: true,
    branding: false,
    support: "dedicated"
  }
};

// Get current subscription
router.get("/subscription", async (req, res) => {
  try {
    const { shop } = req.query;
    const subscription = await prisma.subscription.findUnique({
      where: { shop }
    });

    if (!subscription) {
      return res.json({ plan: "free", status: "active", limits: PLANS.free });
    }

    res.json({
      ...subscription,
      limits: PLANS[subscription.plan] || PLANS.free
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all plans
router.get("/plans", async (req, res) => {
  res.json(PLANS);
});

// Create subscription (using Shopify Billing API)
router.post("/subscribe", async (req, res) => {
  try {
    const { shop, plan } = req.body;
    const planData = PLANS[plan];

    if (!planData) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    // For free plan, just update
    if (plan === "free") {
      await prisma.subscription.update({
        where: { shop },
        data: { plan: "free", status: "active", chargeId: null }
      });
      return res.json({ success: true, plan: "free" });
    }

    // For paid plans, return Shopify billing URL
    // In production, you would use Shopify GraphQL Billing API here
    // For now, we'll simulate the flow
    const returnUrl = `${process.env.HOST}/?shop=${shop}`;

    res.json({
      success: true,
      billingUrl: `https://${shop}/admin/charges?type=recurring_application_charge&name=${planData.name}&price=${planData.price}&return_url=${encodeURIComponent(returnUrl)}`,
      plan,
      price: planData.price
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check usage limits
router.get("/usage", async (req, res) => {
  try {
    const { shop } = req.query;
    const subscription = await prisma.subscription.findUnique({ where: { shop } });
    const plan = PLANS[subscription?.plan || "free"];

    // Count current usage
    const reviewCount = await prisma.review.count({ where: { shop } });
    const requestCount = await prisma.reviewRequest.count({ where: { shop } });
    const photoCount = await prisma.review.count({ 
      where: { shop, photos: { isEmpty: false } } 
    });

    res.json({
      reviews: { used: reviewCount, limit: plan.reviews },
      requests: { used: requestCount, limit: plan.reviewRequests },
      photos: { used: photoCount, allowed: plan.photos },
      plan: subscription?.plan || "free"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;