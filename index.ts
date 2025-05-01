import { Command } from 'commander';
import path from 'path';

// --- Configuration ---
const HEDRA_API_BASE_URL = 'https://api.hedra.com/web-app/public';
const POLLING_INTERVAL_MS = 5000; // Check status every 5 seconds

// --- Helper Functions ---

/**
 * Simple sleep function.
 * @param ms Milliseconds to sleep.
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Custom fetch function to automatically add base URL and API key.
 */
async function hedraFetch(apiKey: string, urlPath: string, options: RequestInit = {}): Promise<Response> {
    const fullUrl = `${HEDRA_API_BASE_URL}${urlPath}`;
    const headers = new Headers(options.headers);
    headers.set('x-api-key', apiKey);
    headers.set('User-Agent', 'Hedra-API-Starter-TS/0.1.0'); // Good practice to identify client

    // Ensure content-type is set for POST requests with body
    if (options.method?.toUpperCase() === 'POST' && options.body && !headers.has('Content-Type')) {
        if (typeof options.body === 'string') {
            headers.set('Content-Type', 'application/json');
        }
        // For FormData, fetch usually sets the correct multipart/form-data header automatically
    }

    return fetch(fullUrl, {
        ...options,
        headers,
    });
}

interface Asset {
    id: string;
    name: string;
    type: 'image' | 'audio';
    // other potential fields...
}

interface Model {
    id: string;
    name: string;
    // other potential fields...
}

interface GenerationStatus {
    id: string;
    status: 'pending' | 'processing' | 'complete' | 'error';
    error_message?: string;
    url?: string; // Download URL
    asset_id?: string; // Output asset ID
    // other potential fields...
}

interface GenerationRequest {
    type: 'video';
    ai_model_id: string;
    start_keyframe_id: string;
    audio_id: string;
    generated_video_inputs: {
        text_prompt: string;
        resolution: string;
        aspect_ratio: string;
        duration_ms?: number;
        seed?: number;
    };
}

interface GenerationResponse {
    id: string;
    // other potential fields...
}

/**
 * Uploads a file asset (image or audio).
 */
async function uploadAsset(apiKey: string, filePath: string, type: 'image' | 'audio'): Promise<string> {
    const fileName = path.basename(filePath);
    console.log(`Creating ${type} asset record for ${fileName}...`);

    const createResponse = await hedraFetch(apiKey, '/assets', {
        method: 'POST',
        body: JSON.stringify({ name: fileName, type }),
    });

    if (!createResponse.ok) {
        const errorBody = await createResponse.text();
        throw new Error(`Error creating ${type} asset: ${createResponse.status} ${createResponse.statusText} - ${errorBody}`);
    }

    const asset: Asset = await createResponse.json() as Asset;
    const assetId = asset.id;
    console.log(`Asset record created with ID: ${assetId}. Uploading file...`);

    const file = Bun.file(filePath);
    const formData = new FormData();
    formData.append('file', file);

    const uploadResponse = await hedraFetch(apiKey, `/assets/${assetId}/upload`, {
        method: 'POST',
        body: formData, // Let fetch set the Content-Type for FormData
    });

    if (!uploadResponse.ok) {
         const errorBody = await uploadResponse.text();
        throw new Error(`Error uploading ${type} file: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorBody}`);
    }

    console.log(`Successfully uploaded ${type} ${fileName} (Asset ID: ${assetId})`);
    return assetId;
}

/**
 * Downloads a file from a URL.
 */
async function downloadFile(url: string, outputPath: string): Promise<void> {
    console.log(`Downloading from ${url} to ${outputPath}...`);
    try {
        // Use standard fetch for potentially pre-signed URLs without auth headers
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Download failed: ${response.status} ${response.statusText}`);
        }
        await Bun.write(outputPath, response); // Bun provides a convenient way to write Response to file
        console.log(`Successfully downloaded file to ${outputPath}`);
    } catch (error) {
        console.error(`Failed to download or save file: ${error instanceof Error ? error.message : String(error)}`);
        throw error; // Re-throw to indicate failure
    }
}


// --- Main Execution ---
async function main() {
    // --- Argument Parsing ---
    const program = new Command();
    program
        .name('hedra-ts-client')
        .description('Generate video using the Hedra API (TypeScript/Bun version)')
        .requiredOption('--aspect_ratio <ratio>', 'Aspect ratio (16:9, 9:16, 1:1)', (value) => {
            if (!['16:9', '9:16', '1:1'].includes(value)) {
                throw new Error('Invalid aspect ratio. Must be 16:9, 9:16, or 1:1.');
            }
            return value;
        })
        .requiredOption('--resolution <res>', 'Resolution (540p, 720p)', (value) => {
            if (!['540p', '720p'].includes(value)) {
                throw new Error('Invalid resolution. Must be 540p or 720p.');
            }
            return value;
        })
        .requiredOption('--text_prompt <prompt>', 'Text prompt for the video')
        .requiredOption('--audio_file <path>', 'Path to the input audio file')
        .requiredOption('--image <path>', 'Path to the input image file')
        .option('--duration <seconds>', 'Optional duration in seconds (float)', parseFloat)
        .option('--seed <number>', 'Optional seed for generation (integer)', parseInt);

    program.parse(process.argv);
    const options = program.opts();

    // --- API Key ---
    const apiKey = process.env.HEDRA_API_KEY; // Bun automatically loads .env
    if (!apiKey) {
        console.error('Error: HEDRA_API_KEY not found in environment variables or .env file.');
        process.exit(1);
    }

    try {
        // --- Get Model ID ---
        console.log(`Fetching models from ${HEDRA_API_BASE_URL}...`);
        const modelsResponse = await hedraFetch(apiKey, '/models');
        if (!modelsResponse.ok) {
            throw new Error(`Failed to fetch models: ${modelsResponse.statusText}`);
        }
        const models: Model[] = await modelsResponse.json() as Model[];
        if (!models || models.length === 0 || !models[0]) {
            throw new Error('No models found or first model is invalid.');
        }
        const modelId = models[0].id;
        console.log(`Using Model ID: ${modelId}`);

        // --- Upload Assets ---
        const imageId = await uploadAsset(apiKey, options.image, 'image');
        const audioId = await uploadAsset(apiKey, options.audio_file, 'audio');

        // --- Start Generation ---
        console.log('Starting video generation...');
        const generationPayload: GenerationRequest = {
            type: 'video',
            ai_model_id: modelId,
            start_keyframe_id: imageId,
            audio_id: audioId,
            generated_video_inputs: {
                text_prompt: options.text_prompt,
                resolution: options.resolution,
                aspect_ratio: options.aspect_ratio,
            },
        };

        if (options.duration) {
            generationPayload.generated_video_inputs.duration_ms = Math.round(options.duration * 1000);
        }
        if (options.seed) {
            generationPayload.generated_video_inputs.seed = options.seed;
        }

        const generationStartResponse = await hedraFetch(apiKey, '/generations', {
            method: 'POST',
            body: JSON.stringify(generationPayload),
        });

        if (!generationStartResponse.ok) {
             const errorBody = await generationStartResponse.text();
            throw new Error(`Failed to start generation: ${generationStartResponse.status} ${generationStartResponse.statusText} - ${errorBody}`);
        }

        const generationResult: GenerationResponse = await generationStartResponse.json() as GenerationResponse;
        const generationId = generationResult.id;
        console.log(`Generation started with ID: ${generationId}. Polling status...`);

        // --- Poll Status ---
        let finalStatus: GenerationStatus | null = null;
        while (true) {
            const statusResponse = await hedraFetch(apiKey, `/generations/${generationId}/status`);
             if (!statusResponse.ok) {
                // Don't throw immediately on status check failure, maybe log and retry?
                console.warn(`Warning: Failed to get status for ${generationId}: ${statusResponse.status} ${statusResponse.statusText}. Retrying...`);
                await sleep(POLLING_INTERVAL_MS);
                continue;
            }

            const statusResult: GenerationStatus = await statusResponse.json() as GenerationStatus;
            console.log(`Current status: ${statusResult.status}`);

            if (statusResult.status === 'complete' || statusResult.status === 'error') {
                finalStatus = statusResult;
                break;
            }

            await sleep(POLLING_INTERVAL_MS);
        }

        // --- Process Final Status ---
        if (finalStatus?.status === 'complete' && finalStatus.url) {
            const outputFilenameBase = finalStatus.asset_id || generationId;
            const outputFilename = `${outputFilenameBase}.mp4`;
            await downloadFile(finalStatus.url, outputFilename);
        } else if (finalStatus?.status === 'error') {
            console.error(`Video generation failed: ${finalStatus.error_message || 'Unknown error'}`);
            process.exitCode = 1; // Indicate failure
        } else {
            console.warn(`Video generation finished with status '${finalStatus?.status}' but no download URL was found.`);
        }

    } catch (error) {
        console.error(`An error occurred: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1; // Indicate failure
    }
}

// Execute main function
main();