import cron from "node-cron";
import prisma from "../db.server";
import shopify from "../shopify.server";

export const runScheduler = async () => {
    console.log("Running Scheduler Job...");

    // Find shops with auto-discount enabled
    const settingsList = await prisma.settings.findMany({
        where: { autoDiscount: true },
    });

    for (const setting of settingsList) {
        const shop = setting.shop;
        console.log(`Processing shop: ${shop}`);

        // Get Session
        const session = await prisma.session.findFirst({
            where: { shop },
        });

        if (!session) {
            console.log(`No session found for ${shop}`);
            continue;
        }

        // Get tracked products
        const products = await prisma.discountProduct.findMany({
            where: { shop },
        });

        if (products.length === 0) continue;

        const client = new shopify.api.clients.Graphql({ session });

        for (const product of products) {
            let newPrice;
            let newIsDiscounted;

            // Logic: Explicitly toggle between +2 and -2 from ORIGINAL price
            // If currently isDiscounted (Has +2), switch to -2 (False?? No let's be explicit)
            // Actually, relying on isDiscounted boolean to toggle phases:
            // True = Currently +2
            // False = Currently -2 (or neutral? Assuming start is neutral, first run becomes +2)

            const parsedOriginal = parseFloat(product.originalPrice);

            if (product.isDiscounted) {
                // Currently in "+2" state (or just "Day 1"). Switch to "-2" state.
                newPrice = (parsedOriginal - 2.00).toFixed(2);
                newIsDiscounted = false; // Using false to represent the "-2" phase
            } else {
                // Currently in "-2" state (or neutral). Switch to "+2" state.
                newPrice = (parsedOriginal + 2.00).toFixed(2);
                newIsDiscounted = true; // Using true to represent the "+2" phase
            }

            console.log(`Updating ${product.productTitle}: ${product.currentPrice} -> ${newPrice}`);

            try {
                // Update Shopify
                const response = await client.request(
                    `#graphql
          mutation updatePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants {
                id
                price
              }
              userErrors {
                field
                message
              }
            }
          }`,
                    {
                        variables: {
                            productId: product.productId,
                            variants: [{ id: product.variantId, price: newPrice }],
                        },
                    }
                );

                if (response.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
                    console.error(response.data.productVariantsBulkUpdate.userErrors);
                    continue;
                }

                // Update DB
                await prisma.discountProduct.update({
                    where: { id: product.id },
                    data: {
                        currentPrice: newPrice,
                        isDiscounted: newIsDiscounted,
                        lastUpdated: new Date(),
                    },
                });

            } catch (error) {
                console.error(`Failed to update ${product.productTitle}`, error);
            }
        }
    }
};

// Initialize Cron Job
export const initScheduler = () => {
    // Schedule to run every day at midnight
    cron.schedule("0 0 * * *", () => {
        runScheduler();
    });
    console.log("Scheduler initialized.");
};
