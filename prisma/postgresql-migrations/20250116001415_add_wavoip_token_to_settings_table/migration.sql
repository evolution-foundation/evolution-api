/*
Warnings:

- A unique constraint covering the columns `[remoteJid,instanceId]` on the table `Chat` will be added. If there are existing duplicate values, this will fail.

*/

-- AlterTable
ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "wavoipToken" VARCHAR(100);
