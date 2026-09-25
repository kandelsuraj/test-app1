-- CreateTable
CREATE TABLE "PriceSigningKey" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "secret" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
