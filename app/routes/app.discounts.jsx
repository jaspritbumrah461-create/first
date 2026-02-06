import { useState } from "react";

import { useLoaderData, useFetcher, useSubmit } from "react-router";
import {
    Page,
    Layout,
    Card,
    Button,
    Text,
    TextField,
    BlockStack,
    InlineStack,
    ResourceList,
    Thumbnail,
    Badge,
    Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runScheduler } from "../services/scheduler.server";

export const loader = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    // Fetch Settings
    let settings = await prisma.settings.findUnique({
        where: { shop },
    });
    if (!settings) {
        settings = await prisma.settings.create({
            data: { shop },
        });
    }

    // Fetch tracked products from DB
    const trackedProducts = await prisma.discountProduct.findMany({
        where: { shop },
    });
    const trackedMap = new Map(trackedProducts.map((p) => [p.productId, p]));

    // Fetch Products from Shopify
    const response = await admin.graphql(
        `#graphql
      query getProducts {
        products(first: 50) {
          edges {
            node {
              id
              title
              handle
              featuredImage {
                url
              }
              variants(first: 1) {
                edges {
                  node {
                    id
                    price
                  }
                }
              }
            }
          }
        }
      }`
    );
    const responseJson = await response.json();
    const shopifyProducts = responseJson.data.products.edges.map((edge) => {
        const node = edge.node;
        const tracked = trackedMap.get(node.id);
        return {
            ...node,
            price: node.variants.edges[0]?.node.price || "0.00",
            variantId: node.variants.edges[0]?.node.id,
            isDiscounted: tracked ? tracked.isDiscounted : false,
            trackedId: tracked ? tracked.id : null,
            isTracked: !!tracked,
        };
    });

    return { shopifyProducts, settings };
};

export const action = async ({ request }) => {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const actionType = formData.get("actionType");

    if (actionType === "SAVE_SETTINGS") {
        const adminDiscount = parseFloat(formData.get("adminDiscount"));
        const autoDiscount = formData.get("autoDiscount") === "true";
        await prisma.settings.upsert({
            where: { shop },
            update: { adminDiscount, autoDiscount },
            create: { shop, adminDiscount, autoDiscount },
        });
        return { status: "success", message: "Settings saved" };
    }

    if (actionType === "TOGGLE_PRODUCT") {
        const productId = formData.get("productId");
        const variantId = formData.get("variantId");
        const title = formData.get("title");
        const price = parseFloat(formData.get("price"));
        const isTracked = formData.get("isTracked") === "true";

        if (isTracked) {
            // Remove from tracking
            await prisma.discountProduct.deleteMany({
                where: { shop, productId },
            });
        } else {
            // Add to tracking
            await prisma.discountProduct.create({
                data: {
                    shop,
                    productId,
                    variantId,
                    productTitle: title,
                    originalPrice: price,
                    currentPrice: price,
                    isDiscounted: false,
                },
            });
        }
        return { status: "success" };
    }

    if (actionType === "RUN_SCHEDULER") {
        await runScheduler();
        return { status: "success", message: "Scheduler run triggered successfully" };
    }

    return { status: "error", message: "Unknown action" };
};

export default function Discounts() {
    const { shopifyProducts, settings } = useLoaderData();
    const fetcher = useFetcher();
    const submit = useSubmit();

    const [adminDiscount, setAdminDiscount] = useState(settings.adminDiscount);
    const [autoDiscount, setAutoDiscount] = useState(settings.autoDiscount);

    const handleSaveSettings = () => {
        fetcher.submit(
            { actionType: "SAVE_SETTINGS", adminDiscount, autoDiscount },
            { method: "POST" }
        );
    };

    const handleRunScheduler = () => {
        fetcher.submit(
            { actionType: "RUN_SCHEDULER" },
            { method: "POST" }
        );
    };

    const toggleProduct = (product) => {
        fetcher.submit(
            {
                actionType: "TOGGLE_PRODUCT",
                productId: product.id,
                variantId: product.variantId,
                title: product.title,
                price: product.price,
                isTracked: product.isTracked,
            },
            { method: "POST" }
        );
    };

    return (
        <Page title="Product Discount Automation">
            <Layout>
                <Layout.Section>
                    <Card>
                        <BlockStack gap="400">
                            <Text variant="headingMd" as="h2">Global Settings</Text>
                            <InlineStack gap="400" align="start" blockAlign="center">
                                <TextField
                                    label="Admin Discount Amount ($)"
                                    type="number"
                                    value={adminDiscount}
                                    onChange={(val) => setAdminDiscount(val)}
                                    autoComplete="off"
                                />
                                <Button
                                    onClick={() => setAutoDiscount(!autoDiscount)}
                                    pressed={autoDiscount}
                                >
                                    {autoDiscount ? "Auto-Discount ON" : "Auto-Discount OFF"}
                                </Button>
                                <div style={{ marginTop: '23px' }}>
                                    <Button variant="primary" onClick={handleSaveSettings} loading={fetcher.state === "submitting"}>
                                        Save Settings
                                    </Button>
                                </div>
                                <div style={{ marginTop: '23px', marginLeft: '10px' }}>
                                    <Button onClick={handleRunScheduler} loading={fetcher.state === "submitting"}>
                                        Test Scheduler (Run Now)
                                    </Button>
                                </div>
                            </InlineStack>
                            {fetcher.data?.message && (
                                <Banner tone="success">{fetcher.data.message}</Banner>
                            )}
                        </BlockStack>
                    </Card>
                </Layout.Section>

                <Layout.Section>
                    <Card padding="0">
                        <ResourceList
                            resourceName={{ singular: "product", plural: "products" }}
                            items={shopifyProducts}
                            renderItem={(item) => {
                                const { id, title, featuredImage, price, isTracked, isDiscounted } = item;
                                const media = (
                                    <Thumbnail
                                        source={featuredImage?.url || ""}
                                        alt={title}
                                    />
                                );

                                return (
                                    <ResourceList.Item
                                        id={id}
                                        media={media}
                                        accessibilityLabel={`View details for ${title}`}
                                    >
                                        <InlineStack align="space-between" blockAlign="center">
                                            <BlockStack gap="200">
                                                <Text variant="bodyMd" fontWeight="bold" as="h3">
                                                    {title}
                                                </Text>
                                                <Text as="span" color="subdued">Price: ${price}</Text>
                                            </BlockStack>

                                            <InlineStack gap="300">
                                                {isTracked && (
                                                    <Badge tone={isDiscounted ? "success" : "info"}>
                                                        {isDiscounted ? "Discounted" : "Tracking"}
                                                    </Badge>
                                                )}
                                                <Button
                                                    variant={isTracked ? "secondary" : "primary"}
                                                    onClick={() => toggleProduct(item)}
                                                    loading={fetcher.state === "submitting" && fetcher.formData?.get("productId") === id}
                                                >
                                                    {isTracked ? "Remove from List" : "Add to Discount"}
                                                </Button>
                                            </InlineStack>
                                        </InlineStack>
                                    </ResourceList.Item>
                                );
                            }}
                        />
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
