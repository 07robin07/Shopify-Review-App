import sgMail from "@sendgrid/mail";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

export async function sendReviewRequest(shop, request) {
  if (!process.env.SENDGRID_API_KEY) return;

  try {
    const settings = await prisma.storeSettings.findUnique({ where: { shop } });

    const msg = {
      to: request.customerEmail,
      from: process.env.FROM_EMAIL || "noreply@reviews.com",
      subject: `How was your recent purchase from ${shop}?`,
      html: `
        <div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;padding:20px">
          <h2>Hi ${request.customerName},</h2>
          <p>Thank you for your recent purchase! We'd love to hear about your experience.</p>
          <div style="text-align:center;margin:30px 0">
            <a href="https://${shop}/products/review?order=${request.orderId}" 
               style="background:#000;color:#fff;padding:15px 30px;text-decoration:none;border-radius:4px;display:inline-block">
              Write a Review
            </a>
          </div>
          ${settings?.enableCoupons ? '<p style="color:#666;font-size:12px">Leave a review and receive a discount code!</p>' : ""}
        </div>
      `
    };

    await sgMail.send(msg);

    await prisma.reviewRequest.update({
      where: { id: request.id },
      data: { status: "sent", sentAt: new Date() }
    });
  } catch (error) {
    console.error("Email send error:", error);
  }
}

export async function sendReviewCoupon(shop, review) {
  if (!process.env.SENDGRID_API_KEY) return;

  try {
    const settings = await prisma.storeSettings.findUnique({ where: { shop } });
    if (!settings?.enableCoupons || !settings.couponCode) return;

    const msg = {
      to: review.customerEmail,
      from: process.env.FROM_EMAIL || "noreply@reviews.com",
      subject: "Thank you for your review! Here's your discount code",
      html: `
        <div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;padding:20px">
          <h2>Thank you for your review, ${review.customerName}!</h2>
          <p>Here's your discount code:</p>
          <div style="background:#f5f5f5;padding:20px;text-align:center;margin:20px 0;border-radius:4px">
            <h1 style="margin:0;color:#000;letter-spacing:2px">${settings.couponCode}</h1>
            <p style="margin:10px 0 0;color:#666">${settings.couponDiscount}% off your next order</p>
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
  } catch (error) {
    console.error("Coupon email error:", error);
  }
}