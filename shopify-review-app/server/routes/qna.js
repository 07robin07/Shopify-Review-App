import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// Get questions for a product (PUBLIC)
router.get("/product/:productId", async (req, res) => {
  try {
    const { productId } = req.params;
    const { shop } = req.query;

    const questions = await prisma.question.findMany({
      where: { shop, productId, status: "answered" },
      orderBy: { votes: "desc" },
      take: 50
    });

    res.json({ questions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit a question (PUBLIC)
router.post("/ask", async (req, res) => {
  try {
    const { shop, productId, productTitle, customerName, customerEmail, question } = req.body;

    const settings = await prisma.storeSettings.findUnique({ where: { shop } });
    if (!settings?.enableQandA) {
      return res.status(403).json({ error: "Q&A is not enabled for this store" });
    }

    const newQuestion = await prisma.question.create({
      data: {
        shop,
        productId,
        productTitle,
        customerName,
        customerEmail,
        question,
        sessionId: "public"
      }
    });

    res.status(201).json(newQuestion);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Answer a question (ADMIN)
router.put("/admin/:id/answer", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, answeredBy } = req.body;

    const updated = await prisma.question.update({
      where: { id },
      data: { answer, answeredBy, answerDate: new Date(), status: "answered" }
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Get all questions
router.get("/admin/all", async (req, res) => {
  try {
    const { shop, status } = req.query;
    const where = { shop };
    if (status) where.status = status;

    const questions = await prisma.question.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100
    });

    res.json({ questions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;