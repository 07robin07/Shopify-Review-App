import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

router.get("/", async (req, res) => {
  try {
    const { shop } = req.query;
    let settings = await prisma.storeSettings.findUnique({ where: { shop } });

    if (!settings) {
      settings = await prisma.storeSettings.create({
        data: { shop, sessionId: "default" }
      });
    }

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/", async (req, res) => {
  try {
    const { shop } = req.query;
    const updates = req.body;

    const settings = await prisma.storeSettings.upsert({
      where: { shop },
      update: updates,
      create: { shop, sessionId: "default", ...updates }
    });

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/requests", async (req, res) => {
  try {
    const { shop, status, page = 1 } = req.query;
    const where = { shop };
    if (status) where.status = status;

    const requests = await prisma.reviewRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (parseInt(page) - 1) * 20,
      take: 20
    });

    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;