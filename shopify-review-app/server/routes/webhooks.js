import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

router.post("/orders", async (req, res) => {
  try {
    const { shop, topic } = req.headers;
    const payload = req.body;

    if (topic === "orders/create" || topic === "orders/fulfilled") {
      await prisma.reviewRequest.create({
        data: {
          shop,
          orderId: payload.id.toString(),
          customerName: `${payload.customer?.first_name || ""} ${payload.customer?.last_name || ""}`.trim(),
          customerEmail: payload.customer?.email || "",
          productIds: payload.line_items?.map(item => item.product_id?.toString()) || [],
          status: "pending"
        }
      });
    }

    res.status(200).send();
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(200).send(); // Always return 200 to Shopify
  }
});

router.post("/gdpr", async (req, res) => {
  // GDPR compliance webhooks
  res.status(200).send();
});

export default router;