import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// Start import job
router.post("/start", async (req, res) => {
  try {
    const { shop, source, data } = req.body;

    // Check plan allows imports
    const subscription = await prisma.subscription.findUnique({ where: { shop } });
    const plan = subscription?.plan || "free";
    if (plan === "free") {
      return res.status(403).json({ error: "Imports require Starter plan or higher" });
    }

    const job = await prisma.importJob.create({
      data: {
        shop,
        sessionId: "import",
        source,
        totalRows: data.length,
        status: "processing"
      }
    });

    // Process import in background
    processImport(job.id, data, shop);

    res.json({ jobId: job.id, status: "processing" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get import status
router.get("/status/:jobId", async (req, res) => {
  try {
    const job = await prisma.importJob.findUnique({
      where: { id: req.params.jobId }
    });
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all imports for shop
router.get("/all", async (req, res) => {
  try {
    const { shop } = req.query;
    const jobs = await prisma.importJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" }
    });
    res.json({ jobs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export reviews
router.get("/export", async (req, res) => {
  try {
    const { shop } = req.query;
    const reviews = await prisma.review.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" }
    });

    // Convert to CSV
    const csv = convertToCSV(reviews);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=reviews.csv");
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function processImport(jobId, data, shop) {
  let processed = 0;
  let failed = 0;

  for (const row of data) {
    try {
      await prisma.review.create({
        data: {
          shop,
          sessionId: "import",
          productId: row.product_id || row.productId,
          productTitle: row.product_title || row.productTitle || "Unknown",
          customerName: row.customer_name || row.customerName || "Anonymous",
          customerEmail: row.customer_email || row.customerEmail || "",
          rating: parseInt(row.rating) || 5,
          title: row.title || "",
          body: row.body || row.review || "",
          photos: row.photos || [],
          verified: row.verified === true || row.verified === "true",
          published: true,
          source: "import"
        }
      });
      processed++;
    } catch (e) {
      failed++;
    }
  }

  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      status: failed > 0 ? "completed_with_errors" : "completed",
      processed,
      failed,
      completedAt: new Date()
    }
  });
}

function convertToCSV(reviews) {
  const headers = ["id", "product_id", "product_title", "customer_name", "customer_email", "rating", "title", "body", "photos", "verified", "published", "created_at"];
  const rows = reviews.map(r => [
    r.id, r.productId, r.productTitle, r.customerName, r.customerEmail,
    r.rating, r.title, r.body, r.photos.join("|"), r.verified, r.published, r.createdAt
  ]);

  return [headers.join(","), ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))].join("\n");
}

export default router;