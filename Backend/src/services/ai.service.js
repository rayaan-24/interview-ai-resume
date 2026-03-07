const { GoogleGenAI } = require("@google/genai")
const { z } = require("zod")
const { zodToJsonSchema } = require("zod-to-json-schema")
const puppeteer = require("puppeteer")

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_GENAI_API_KEY
})


const interviewReportSchema = z.object({
    matchScore: z.coerce.number().min(0).max(100).describe("A score between 0 and 100 indicating how well the candidate's profile matches the job describe"),
    technicalQuestions: z.array(z.object({
        question: z.string().describe("The technical question can be asked in the interview"),
        intention: z.string().describe("The intention of interviewer behind asking this question"),
        answer: z.string().describe("How to answer this question, what points to cover, what approach to take etc.")
    })).min(1).describe("Technical questions that can be asked in the interview along with their intention and how to answer them"),
    behavioralQuestions: z.array(z.object({
        question: z.string().describe("The technical question can be asked in the interview"),
        intention: z.string().describe("The intention of interviewer behind asking this question"),
        answer: z.string().describe("How to answer this question, what points to cover, what approach to take etc.")
    })).min(1).describe("Behavioral questions that can be asked in the interview along with their intention and how to answer them"),
    skillGaps: z.array(z.object({
        skill: z.string().describe("The skill which the candidate is lacking"),
        severity: z.enum([ "low", "medium", "high" ]).describe("The severity of this skill gap, i.e. how important is this skill for the job and how much it can impact the candidate's chances")
    })).min(1).describe("List of skill gaps in the candidate's profile along with their severity"),
    preparationPlan: z.array(z.object({
        day: z.number().describe("The day number in the preparation plan, starting from 1"),
        focus: z.string().describe("The main focus of this day in the preparation plan, e.g. data structures, system design, mock interviews etc."),
        tasks: z.array(z.string()).describe("List of tasks to be done on this day to follow the preparation plan, e.g. read a specific book or article, solve a set of problems, watch a video etc.")
    })).min(1).describe("A day-wise preparation plan for the candidate to follow in order to prepare for the interview effectively"),
    title: z.string().describe("The title of the job for which the interview report is generated"),
})

const interviewReportLooseSchema = interviewReportSchema.partial()

function ensureArray(value) {
    return Array.isArray(value) ? value : []
}

function clampText(value, maxChars) {
    const text = (value || "").toString().trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function buildServiceError(message, statusCode) {
    const error = new Error(message)
    error.statusCode = statusCode
    return error
}

function parseProviderError(error) {
    if (!error?.message) return null
    try {
        return JSON.parse(error.message)
    } catch (_) {
        return null
    }
}

function extractRetryDelay(errorPayload) {
    const retryInfo = errorPayload?.error?.details?.find?.(detail => detail["@type"]?.includes("RetryInfo"))
    return retryInfo?.retryDelay || null
}

function isQuotaExceeded(error, errorPayload) {
    const message = `${error?.message || ""}`.toLowerCase()
    const providerMessage = `${errorPayload?.error?.message || ""}`.toLowerCase()
    return (
        message.includes("quota") ||
        message.includes("resource_exhausted") ||
        providerMessage.includes("quota") ||
        providerMessage.includes("resource_exhausted")
    )
}

function extractJsonObject(rawText) {
    const text = (rawText || "").trim()
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/i)
    const candidate = codeBlockMatch ? codeBlockMatch[1] : text

    try {
        return JSON.parse(candidate)
    } catch (_) {
        const firstBrace = candidate.indexOf("{")
        const lastBrace = candidate.lastIndexOf("}")
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            return JSON.parse(candidate.slice(firstBrace, lastBrace + 1))
        }
        throw new Error("Model response was not valid JSON.")
    }
}

function normalizeInterviewReport(raw, jobDescription) {
    const technicalQuestions = raw.technicalQuestions || raw.technical_questions || raw.technical || []
    const behavioralQuestions = raw.behavioralQuestions || raw.behavioral_questions || raw.behavioral || []
    const skillGaps = raw.skillGaps || raw.skill_gaps || raw.gaps || []
    const preparationPlan = raw.preparationPlan || raw.preparation_plan || raw.roadmap || []
    const title = raw.title || jobDescription

    const normalized = {
        ...raw,
        title,
        matchScore: raw.matchScore,
        technicalQuestions: ensureArray(technicalQuestions),
        behavioralQuestions: ensureArray(behavioralQuestions),
        skillGaps: ensureArray(skillGaps),
        preparationPlan: ensureArray(preparationPlan)
    }

    const parsed = interviewReportLooseSchema.safeParse(normalized)
    if (!parsed.success) {
        throw new Error("AI response schema validation failed.")
    }

    const candidate = parsed.data
    if (
        ensureArray(candidate.technicalQuestions).length === 0 ||
        ensureArray(candidate.behavioralQuestions).length === 0 ||
        ensureArray(candidate.skillGaps).length === 0 ||
        ensureArray(candidate.preparationPlan).length === 0
    ) {
        throw new Error("AI response contained empty required sections.")
    }

    return {
        title: candidate.title || title,
        matchScore: typeof candidate.matchScore === "number" ? candidate.matchScore : 70,
        technicalQuestions: candidate.technicalQuestions,
        behavioralQuestions: candidate.behavioralQuestions,
        skillGaps: candidate.skillGaps,
        preparationPlan: candidate.preparationPlan
    }
}

async function generateInterviewReport({ resume, selfDescription, jobDescription }) {

    const reducedResume = clampText(resume, 6000)
    const reducedSelfDescription = clampText(selfDescription, 1800)
    const reducedJobDescription = clampText(jobDescription, 2200)

    const prompt = `Generate an interview report for a candidate with the following details:
                        Resume: ${reducedResume}
                        Self Description: ${reducedSelfDescription}
                        Job Description: ${reducedJobDescription}

                        IMPORTANT:
                        - Return a JSON object only.
                        - Every section must be non-empty.
                        - Include at least 5 technicalQuestions, 5 behavioralQuestions, 3 skillGaps, and 7 preparationPlan days.
                        - Use exact keys: title, matchScore, technicalQuestions, behavioralQuestions, skillGaps, preparationPlan.
`
    const modelsToTry = [
        process.env.GOOGLE_GENAI_MODEL,
        "gemini-2.5-flash",
        "gemini-2.0-flash"
    ].filter(Boolean)

    let lastError = null

    for (const modelName of modelsToTry) {
        try {
            const response = await ai.models.generateContent({
                model: modelName,
                contents: prompt,
                config: {
                    responseMimeType: "application/json"
                }
            })

            const parsed = extractJsonObject(response.text)
            return normalizeInterviewReport(parsed, jobDescription)
        } catch (error) {
            lastError = error
            const providerError = parseProviderError(error)
            if (isQuotaExceeded(error, providerError)) {
                const retryDelay = extractRetryDelay(providerError)
                const retryHint = retryDelay ? ` Retry after ${retryDelay}.` : ""
                throw buildServiceError(`Gemini API quota exceeded.${retryHint} Check billing/plan at https://ai.google.dev/gemini-api/docs/rate-limits`, 429)
            }
        }
    }
    throw buildServiceError(`Interview report AI generation failed: ${lastError?.message || "unknown error"}`, 502)


}



async function generatePdfFromHtml(htmlContent) {
    const browser = await puppeteer.launch()
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: "networkidle0" })

    const pdfBuffer = await page.pdf({
        format: "A4", margin: {
            top: "20mm",
            bottom: "20mm",
            left: "15mm",
            right: "15mm"
        }
    })

    await browser.close()

    return pdfBuffer
}

async function generateResumePdf({ resume, selfDescription, jobDescription }) {

    const resumePdfSchema = z.object({
        html: z.string().describe("The HTML content of the resume which can be converted to PDF using any library like puppeteer")
    })

    const prompt = `Generate resume for a candidate with the following details:
                        Resume: ${resume}
                        Self Description: ${selfDescription}
                        Job Description: ${jobDescription}

                        the response should be a JSON object with a single field "html" which contains the HTML content of the resume which can be converted to PDF using any library like puppeteer.
                        The resume should be tailored for the given job description and should highlight the candidate's strengths and relevant experience. The HTML content should be well-formatted and structured, making it easy to read and visually appealing.
                        The content of resume should be not sound like it's generated by AI and should be as close as possible to a real human-written resume.
                        you can highlight the content using some colors or different font styles but the overall design should be simple and professional.
                        The content should be ATS friendly, i.e. it should be easily parsable by ATS systems without losing important information.
                        The resume should not be so lengthy, it should ideally be 1-2 pages long when converted to PDF. Focus on quality rather than quantity and make sure to include all the relevant information that can increase the candidate's chances of getting an interview call for the given job description.
                    `

    const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: zodToJsonSchema(resumePdfSchema),
        }
    })


    const jsonContent = JSON.parse(response.text)

    const pdfBuffer = await generatePdfFromHtml(jsonContent.html)

    return pdfBuffer

}

module.exports = { generateInterviewReport, generateResumePdf }
