import express from "express";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import cors from "cors";
import tesseract from "tesseract.js";

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

const launchBrowser = async () => {
    return await puppeteer.launch({
        headless: false,
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--proxy-server='direct://'",
            "--proxy-bypass-list=*",
        ],
    });
};

app.post("/fetch-case", async (req, res) => {
    const { courtComplex, caseType, caseNumber, caseYear } = req.body;

    if (!courtComplex || !caseType || !caseNumber || !caseYear) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
        );

        console.log("Navigating to the court website...");
        await page.goto("https://northeast.dcourts.gov.in/case-status-search-by-case-number/", {
            waitUntil: "domcontentloaded",
            timeout: 90000,
        });

        console.log("✅ Page loaded successfully.");

        console.log("Selecting 'Court Complex' radio button...");
        await page.waitForSelector("#chkYes", { visible: true, timeout: 30000 });
        await page.evaluate(() => document.querySelector("#chkYes").click());

        console.log("Waiting for Court Complex dropdown...");
        await page.waitForSelector("#est_code", { visible: true, timeout: 30000 });
        await page.select("#est_code", courtComplex);
        console.log("✅ Court Complex selected.");

        console.log("Enabling and selecting Case Type...");
        await page.waitForSelector("#case_type", { visible: true, timeout: 10000 });
        await page.evaluate(() => document.querySelector("#case_type").removeAttribute("disabled"));
        await page.select("#case_type", caseType);
        console.log("✅ Case Type selected.");

        console.log("Entering Case Number...");
        await page.waitForSelector("#reg_no", { visible: true, timeout: 10000 });
        await page.type("#reg_no", caseNumber);
        console.log("✅ Case Number entered.");

        console.log("Entering Case Year...");
        await page.waitForSelector("#reg_year", { visible: true, timeout: 10000 });
        await page.type("#reg_year", caseYear);
        console.log("✅ Case Year entered.");

        console.log("Extracting CAPTCHA image...");
        await page.waitForSelector("#siwp_captcha_image_0", { visible: true, timeout: 30000 });
        const captchaImage = await page.$("#siwp_captcha_image_0");

        if (!captchaImage) {
            throw new Error("CAPTCHA image not found!");
        }

        await captchaImage.screenshot({ path: "captcha.png" });
        console.log("Solving CAPTCHA...");

        let solvedCaptcha = "";
        let captchaAttempts = 3;

        for (let i = 0; i < captchaAttempts; i++) {
            const { data: { text } } = await tesseract.recognize("captcha.png");
            solvedCaptcha = text.replace(/\s/g, "").trim();

            console.log(`OCR Attempt ${i + 1}:`, solvedCaptcha);

            if (solvedCaptcha.length >= 4) {
                break;
            }

            console.log("OCR failed. Refreshing CAPTCHA...");
            await page.click(".captcha-refresh-btn");

            // **🔄 FIXED: Wait properly before retrying**
            await new Promise(resolve => setTimeout(resolve, 3000));

            await captchaImage.screenshot({ path: "captcha.png" });
        }

        if (!solvedCaptcha || solvedCaptcha.length < 4) {
            console.log("❌ CAPTCHA was not detected correctly! Stopping execution.");
            await browser.close();
            return res.status(500).json({ error: "Failed to solve CAPTCHA correctly." });
        }

        await page.type("#siwp_captcha_value_0", solvedCaptcha);
        console.log("✅ CAPTCHA entered.");

        console.log("Submitting form...");
        const [response] = await Promise.all([
            page.waitForResponse(response => response.url().includes("case-status-search") && response.status() === 200, { timeout: 90000 }),
            page.click('input[name="submit"]')
        ]);

        if (!response.ok()) {
            throw new Error(`Form submission failed with status: ${response.status()}`);
        }
        console.log("✅ Form submitted successfully.");

        console.log("Extracting case details...");
        await page.waitForSelector(".case-title", { timeout: 30000 });

        const caseInfo = await page.evaluate(() => {
            return {
                caseTitle: document.querySelector(".case-title")?.innerText || "N/A",
                caseStatus: document.querySelector(".case-status")?.innerText || "N/A",
                hearingDate: document.querySelector(".hearing-date")?.innerText || "N/A",
                orderJudgment: document.querySelector(".order-judgment")?.innerText || "N/A",
            };
        });

        console.log("✅ Case details fetched:", caseInfo);
        await browser.close();

        res.status(200).json({ success: true, data: caseInfo });

    } catch (error) {
        console.error("❌ ERROR:", error.stack || error.message || error);
        
        // **🔄 FIX: Restart browser if it crashes**
        if (browser) await browser.close();

        res.status(500).json({ error: "An error occurred while fetching case details", details: error.stack || error.message });
    }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
