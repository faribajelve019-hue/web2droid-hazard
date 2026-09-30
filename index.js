const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 3000);

const ROOT = "/tmp/web2droid";
const JOBS_DIR = path.join(ROOT, "jobs");
const BUILDS_DIR = path.join(ROOT, "builds");

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });

app.use(express.json({
    limit: "12mb"
}));

function id() {
    return "job_" + Date.now() + "_" +
        crypto.randomBytes(5).toString("hex");
}

function validUrl(value) {
    try {
        const u = new URL(value);

        return (
            u.protocol === "http:" ||
            u.protocol === "https:"
        );
    } catch {
        return false;
    }
}

function validPackage(value) {
    return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value);
}

function safeName(value) {
    return String(value || "Web App")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .trim()
        .substring(0, 40) || "Web App";
}

function write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
}

function createAndroidProject(job) {
    const project = job.projectDir;

    const packageName = job.packageName;
    const appName = safeName(job.appName);
    const url = job.url;

    const packagePath = packageName.replace(/\./g, "/");

    /*
     * Android project
     */

    write(
        path.join(project, "settings.gradle"),
`pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Web2Droid"
include(":app")
`
    );

    write(
        path.join(project, "build.gradle"),
`plugins {
    id "com.android.application" version "8.5.2" apply false
}
`
    );

    write(
        path.join(project, "app", "build.gradle"),
`plugins {
    id "com.android.application"
}

android {
    namespace "${packageName}"
    compileSdk 35

    defaultConfig {
        applicationId "${packageName}"
        minSdk 23
        targetSdk 35
        versionCode 1
        versionName "1.0"
    }
}

dependencies {
}
`
    );

    write(
        path.join(
            project,
            "app",
            "src",
            "main",
            "AndroidManifest.xml"
        ),
`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:theme="@style/AppTheme"
        android:label="${appName}"
        android:usesCleartextTraffic="true"
        android:hardwareAccelerated="true">

        <activity
            android:name=".MainActivity"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

    </application>

</manifest>
`
    );

    write(
        path.join(
            project,
            "app",
            "src",
            "main",
            "res",
            "values",
            "styles.xml"
        ),
`<?xml version="1.0" encoding="utf-8"?>
<resources>

    <style name="AppTheme"
        parent="android:style/Theme.Material.Light.NoActionBar">

        <item name="android:fontFamily">sans</item>
        <item name="android:colorAccent">#7C4DFF</item>
        <item name="android:navigationBarColor">#000000</item>
        <item name="android:statusBarColor">#000000</item>

    </style>

</resources>
`
    );

    /*
     * Java WebView
     */

    const java = `
package ${packageName};

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);

        WebSettings settings = webView.getSettings();

        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        webView.setWebViewClient(new WebViewClient());

        webView.loadUrl("${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}");

        setContentView(webView);
    }

    @Override
    public void onBackPressed() {

        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
`;

    write(
        path.join(
            project,
            "app",
            "src",
            "main",
            "java",
            packagePath,
            "MainActivity.java"
        ),
        java
    );

    /*
     * Gradle wrapper
     *
     * Blitz Docker image contains Gradle.
     * We use system Gradle during build.
     */

    return project;
}

function runGradle(project, job) {

    return new Promise((resolve, reject) => {

        job.status = "building";
        job.progress = 35;

        const args = [
            "assembleRelease",
            "--no-daemon",
            "--stacktrace"
        ];

        const child = execFile(
            "gradle",
            args,
            {
                cwd: project,
                timeout: 10 * 60 * 1000,
                maxBuffer: 20 * 1024 * 1024
            },
            (error, stdout, stderr) => {

                job.logs.push(stdout || "");
                job.logs.push(stderr || "");

                if (error) {
                    reject(
                        new Error(
                            stderr ||
                            stdout ||
                            error.message
                        )
                    );
                    return;
                }

                const apk = path.join(
                    project,
                    "app",
                    "build",
                    "outputs",
                    "apk",
                    "release",
                    "app-release.apk"
                );

                if (!fs.existsSync(apk)) {
                    reject(
                        new Error(
                            "APK was not created"
                        )
                    );
                    return;
                }

                resolve(apk);
            }
        );

        child.stdout?.on("data", data => {
            job.logs.push(String(data));
        });

        child.stderr?.on("data", data => {
            job.logs.push(String(data));
        });
    });
}

async function buildJob(job) {

    try {

        job.status = "preparing";
        job.progress = 10;

        createAndroidProject(job);

        job.status = "building";
        job.progress = 30;

        const apk = await runGradle(
            job.projectDir,
            job
        );

        const destination = path.join(
            BUILDS_DIR,
            job.id + ".apk"
        );

        fs.copyFileSync(
            apk,
            destination
        );

        job.status = "completed";
        job.progress = 100;
        job.apk = destination;
        job.downloadUrl =
            "/api/v1/download/" + job.id;

        job.completedAt =
            new Date().toISOString();

        saveJob(job);

    } catch (error) {

        job.status = "failed";
        job.progress = 0;
        job.error = error.message;

        job.logs.push(
            "ERROR: " + error.stack
        );

        saveJob(job);
    }
}

function saveJob(job) {

    const publicJob = {
        id: job.id,
        url: job.url,
        packageName: job.packageName,
        appName: job.appName,
        status: job.status,
        progress: job.progress,
        createdAt: job.createdAt,
        completedAt: job.completedAt || null,
        downloadUrl: job.downloadUrl || null,
        error: job.error || null,
        logs: job.logs.slice(-100)
    };

    fs.writeFileSync(
        path.join(JOBS_DIR, job.id + ".json"),
        JSON.stringify(publicJob, null, 2)
    );
}

function loadJob(jobId) {

    const file = path.join(
        JOBS_DIR,
        jobId + ".json"
    );

    if (!fs.existsSync(file)) {
        return null;
    }

    return JSON.parse(
        fs.readFileSync(file, "utf8")
    );
}

/*
 * Home
 */

app.get("/", (req, res) => {

    res.json({
        name: "Hazard Studio Web2Droid",
        version: "1.0.0",
        status: "online",
        endpoints: {
            health: "GET /health",
            generate: "POST /api/v1/generate-apk",
            job: "GET /api/v1/job/:id",
            download: "GET /api/v1/download/:id"
        }
    });
});

/*
 * Health
 */

app.get("/health", (req, res) => {

    res.json({
        status: "ok",
        service: "web2droid",
        time: new Date().toISOString()
    });
});

/*
 * Generate APK
 */

app.post(
    "/api/v1/generate-apk",
    async (req, res) => {

        try {

            const {
                url,
                packageName,
                options = {}
            } = req.body;

            if (!url) {
                return res.status(400).json({
                    error: "url is required"
                });
            }

            if (!validUrl(url)) {
                return res.status(400).json({
                    error: "Invalid URL"
                });
            }

            if (!packageName) {
                return res.status(400).json({
                    error: "packageName is required"
                });
            }

            if (!validPackage(packageName)) {
                return res.status(400).json({
                    error: "Invalid Android package name"
                });
            }

            const jobId = id();

            const job = {

                id: jobId,

                url,

                packageName,

                appName:
                    safeName(
                        options.appName ||
                        "Web App"
                    ),

                projectDir:
                    path.join(
                        ROOT,
                        jobId
                    ),

                status: "queued",

                progress: 0,

                createdAt:
                    new Date().toISOString(),

                logs: [
                    "Job created"
                ]
            };

            saveJob(job);

            /*
             * Start asynchronously.
             */

            setImmediate(() => {
                buildJob(job);
            });

            res.status(202).json({

                success: true,

                jobId,

                status: "queued",

                statusUrl:
                    "/api/v1/job/" +
                    jobId
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/*
 * Job status
 */

app.get(
    "/api/v1/job/:id",
    (req, res) => {

        const job =
            loadJob(req.params.id);

        if (!job) {

            return res.status(404).json({
                error: "Job not found"
            });
        }

        res.json(job);
    }
);

/*
 * Download APK
 */

app.get(
    "/api/v1/download/:id",
    (req, res) => {

        const job =
            loadJob(req.params.id);

        if (!job) {

            return res.status(404).json({
                error: "Job not found"
            });
        }

        if (job.status !== "completed") {

            return res.status(409).json({
                error: "APK is not ready",
                status: job.status
            });
        }

        const apk =
            path.join(
                BUILDS_DIR,
                req.params.id + ".apk"
            );

        if (!fs.existsSync(apk)) {

            return res.status(404).json({
                error: "APK file not found"
            });
        }

        res.download(
            apk,
            `${job.appName || "WebApp"}.apk`
        );
    }
);

/*
 * 404
 */

app.use((req, res) => {

    res.status(404).json({
        error: "Not found"
    });
});

/*
 * Start
 */

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Web2Droid running on port ${PORT}`
    );

});
