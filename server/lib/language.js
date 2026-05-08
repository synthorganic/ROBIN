/**
 * Language resolution helpers.
 *
 * Central logic for resolving language preferences into provider-specific
 * voice/language settings. Each TTS/STT provider checks support and falls
 * back to English with a warning when the requested language isn't available.
 * @module
 */
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from './constants.js';
/** Look up a language config by ISO 639-1 code. */
export function resolveLanguage(code) {
    return SUPPORTED_LANGUAGES.find((l) => l.code === code);
}
/** Get the Edge TTS voice name for a language + gender combination. */
export function getEdgeTtsVoice(langCode, gender = 'female') {
    const lang = resolveLanguage(langCode);
    if (!lang) {
        const fallback = resolveLanguage(DEFAULT_LANGUAGE);
        return fallback.edgeTtsVoices[gender];
    }
    return lang.edgeTtsVoices[gender];
}
/** Get the Qwen3 language string for a language code (null if unsupported). */
export function getQwen3Language(langCode) {
    const lang = resolveLanguage(langCode);
    return lang?.qwen3Language ?? null;
}
/** Check if a language is supported by a given provider. */
export function isLanguageSupported(provider, langCode) {
    const lang = resolveLanguage(langCode);
    if (!lang)
        return false;
    switch (provider) {
        case 'edge':
            // All 11 languages have Edge TTS voices
            return true;
        case 'qwen3':
            return lang.qwen3Language !== null;
        case 'openai':
            // OpenAI TTS auto-detects language from input text
            return true;
        default:
            return false;
    }
}
/** Get fallback info for a provider + language combination. */
export function getFallbackInfo(provider, langCode) {
    const mapped = provider === 'replicate' ? 'qwen3' : provider;
    const supported = isLanguageSupported(mapped, langCode);
    const lang = resolveLanguage(langCode);
    const langName = lang?.name || langCode;
    if (supported) {
        return { supported: true, fallbackLang: langCode };
    }
    return {
        supported: false,
        fallbackLang: DEFAULT_LANGUAGE,
        warning: `${provider === 'replicate' ? 'Qwen3 TTS' : provider} doesn't support ${langName}. Voice output will use English.`,
    };
}
