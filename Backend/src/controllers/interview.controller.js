const pdfParse = require("pdf-parse")
const { generateInterviewReport, generateResumePdf } = require("../services/ai.service")
const interviewReportModel = require("../models/interviewReport.model")

function isEmptyArray(value) {
    return !Array.isArray(value) || value.length === 0
}

function needsInterviewDataBackfill(interviewReport) {
    return (
        isEmptyArray(interviewReport.technicalQuestions) ||
        isEmptyArray(interviewReport.behavioralQuestions) ||
        isEmptyArray(interviewReport.skillGaps) ||
        isEmptyArray(interviewReport.preparationPlan)
    )
}

function buildReportTitle(rawTitle, fallbackTitle = "Untitled Position") {
    const source = (rawTitle || fallbackTitle).replace(/\s+/g, " ").trim()
    if (!source) return fallbackTitle
    return source.length > 90 ? `${source.slice(0, 90).trim()}...` : source
}



/**
 * @description Controller to generate interview report based on user self description, resume and job description.
 */
async function generateInterViewReportController(req, res) {
    
    try {
        const { selfDescription, jobDescription } = req.body

        if (!jobDescription) {
            return res.status(400).json({ message: "Job description is required." })
        }

        if (!req.file && !selfDescription) {
            return res.status(400).json({ message: "Either resume file or self description is required." })
        }

        let resumeText = ""
        if (req.file) {
            if (req.file.mimetype !== "application/pdf") {
                return res.status(400).json({ message: "Only PDF resume files are supported." })
            }

            const resumeContent = await (new pdfParse.PDFParse(Uint8Array.from(req.file.buffer))).getText()
            resumeText = resumeContent.text || ""
        }

        const interViewReportByAi = await generateInterviewReport({
            resume: resumeText,
            selfDescription: selfDescription || "",
            jobDescription
        })

        const reportTitle = buildReportTitle(interViewReportByAi?.title || jobDescription, "Untitled Position")

        const interviewReport = await interviewReportModel.create({
            user: req.user.id,
            resume: resumeText,
            selfDescription: selfDescription || "",
            jobDescription,
            ...interViewReportByAi,
            title: reportTitle
        })

        res.status(201).json({
            message: "Interview report generated successfully.",
            interviewReport
        })
    } catch (error) {
        console.error("Interview report generation error:", error)
        const statusCode = error?.statusCode || 500
        res.status(statusCode).json({ message: "Failed to generate interview report.", error: error.message })
    }

}

/**
 * @description Controller to get interview report by interviewId.
 */
async function getInterviewReportByIdController(req, res) {

    const { interviewId } = req.params

    let interviewReport = await interviewReportModel.findOne({ _id: interviewId, user: req.user.id })

    if (!interviewReport) {
        return res.status(404).json({
            message: "Interview report not found."
        })
    }

    // Backfill previously stored incomplete reports so old records become usable.
    if (needsInterviewDataBackfill(interviewReport)) {
        try {
            const regeneratedReport = await generateInterviewReport({
                resume: interviewReport.resume || "",
                selfDescription: interviewReport.selfDescription || "",
                jobDescription: interviewReport.jobDescription || interviewReport.title
            })

            interviewReport.matchScore = regeneratedReport.matchScore
            interviewReport.technicalQuestions = regeneratedReport.technicalQuestions
            interviewReport.behavioralQuestions = regeneratedReport.behavioralQuestions
            interviewReport.skillGaps = regeneratedReport.skillGaps
            interviewReport.preparationPlan = regeneratedReport.preparationPlan
            interviewReport.title = buildReportTitle(regeneratedReport.title || interviewReport.title, "Untitled Position")

            await interviewReport.save()
        } catch (error) {
            console.error("Failed to backfill interview report:", error.message)
        }
    }

    res.status(200).json({
        message: "Interview report fetched successfully.",
        interviewReport
    })
}


/** 
 * @description Controller to get all interview reports of logged in user.
 */
async function getAllInterviewReportsController(req, res) {
    const interviewReports = await interviewReportModel.find({ user: req.user.id }).sort({ createdAt: -1 }).select("-resume -selfDescription -jobDescription -__v -technicalQuestions -behavioralQuestions -skillGaps -preparationPlan")

    res.status(200).json({
        message: "Interview reports fetched successfully.",
        interviewReports
    })
}


/**
 * @description Controller to generate resume PDF based on user self description, resume and job description.
 */
async function generateResumePdfController(req, res) {
    const { interviewReportId } = req.params

    const interviewReport = await interviewReportModel.findById(interviewReportId)

    if (!interviewReport) {
        return res.status(404).json({
            message: "Interview report not found."
        })
    }

    const { resume, jobDescription, selfDescription } = interviewReport

    const pdfBuffer = await generateResumePdf({ resume, jobDescription, selfDescription })

    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=resume_${interviewReportId}.pdf`
    })

    res.send(pdfBuffer)
}

module.exports = { generateInterViewReportController, getInterviewReportByIdController, getAllInterviewReportsController, generateResumePdfController }
