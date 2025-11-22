import { GoogleGenAI, Type, Modality, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { DreamAnalysis, AudioData } from "../types";

// API Key initialization per guidelines
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Güvenlik Ayarları: İçerik filtrelerine takılmamak için (Sadece Metin Modelleri İçin)
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Yardımcı Fonksiyon: JSON Ayıklayıcı
function extractJSON(text: string): any {
  try {
    let cleanText = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanText);
  } catch (e) {
    const firstOpen = text.indexOf('{');
    const lastClose = text.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1) {
      const candidate = text.substring(firstOpen, lastClose + 1);
      try {
        return JSON.parse(candidate);
      } catch (e2) {}
    }
    throw new Error("JSON formatı algılanamadı.");
  }
}

// Yardımcı: TTS için metni temizle
function cleanTextForTTS(text: string): string {
  return text
    .replace(/[*_~`]/g, '') // Markdown sembollerini kaldır
    .replace(/\[.*?\]/g, '') // Linkleri kaldır
    .replace(/^\s*[-+*]\s+/gm, '') // Liste işaretlerini kaldır
    .replace(/#{1,6}\s+/g, '') // Başlık işaretlerini kaldır
    .trim();
}

// Yardımcı: Uzun metinleri cümle bütünlüğünü bozmadan parçalara ayırır
export function splitTextForTTS(text: string, limit: number = 600): string[] {
    // Metni temizle
    const clean = cleanTextForTTS(text);
    // Cümlelere böl (Nokta, ünlem, soru işareti ve ardından boşluk veya satır sonu)
    const sentences = clean.match(/[^.!?]+[.!?]+["']?|.+$/g) || [clean];
    
    const chunks: string[] = [];
    let currentChunk = "";

    for (const sentence of sentences) {
        if ((currentChunk + sentence).length <= limit) {
            currentChunk += sentence + " ";
        } else {
            if (currentChunk.trim()) chunks.push(currentChunk.trim());
            currentChunk = sentence + " ";
        }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());

    return chunks;
}

// Yardımcı: Timeout'lu Fetch
async function withTimeout<T>(promise: Promise<T>, ms: number = 60000): Promise<T> {
    let timer: any;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("İstek zaman aşımına uğradı.")), ms);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timer);
        return result;
    } catch (error) {
        clearTimeout(timer);
        throw error;
    }
}

// 1. Transcribe Audio
export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  const base64Audio = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result as string;
      const base64 = res.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(audioBlob);
  });

  const mimeType = audioBlob.type || 'audio/webm';

  try {
    const response = await withTimeout(ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
        parts: [
            { inlineData: { mimeType: mimeType, data: base64Audio } },
            { text: "Lütfen bu ses dosyasını tam olarak metne dök. Sadece söylenenleri yaz." }
        ]
        }
    }));
    return response.text || "";
  } catch (error: any) {
    console.error("Transcribe Error:", error);
    throw new Error(`Ses işlenirken hata: ${error.message || error}`);
  }
};

// 2. Analyze Dream
export const analyzeDreamText = async (dreamText: string): Promise<DreamAnalysis> => {
  try {
    const response = await withTimeout(ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Aşağıdaki rüyayı yorumla. Yorumun psikolojik tabanlı, gerçekçi ve güncel hayatla ilişkili olsun.

        ÖNEMLİ: 
        1. Mistik, falcı veya masalsı bir dil KULLANMA. Bunun yerine psikolojik analiz, bilinçaltı sembolizmi ve gerçek hayat pratikleri üzerine odaklan.
        2. Rüyayı gören kişinin günlük hayatındaki stresler, ilişkiler, kariyer veya duygusal durumuyla bağlantılar kur. Somut çıkarımlarda bulun.
        3. Kullanıcıya detaylı bir analiz sun. Metin uzunluğu 2500 karaktere kadar çıkabilir. Samimi, yapıcı ve anlaşılır bir dil kullan.
        4. Ayrıca, bu rüyayı görselleştirmek için bir yapay zeka resim oluşturucusuna (AI Image Generator) verilecek İNGİLİZCE bir 'imagePrompt' oluştur. Bu prompt; soyut, sanatsal ama net ve GÜVENLİ (NSFW olmayan, şiddet içermeyen) olmalı.
        
        Rüya: "${dreamText}"
        
        Yanıtı MÜMKÜNSE şu JSON formatında ver:
        {
        "sentiment": "positive" veya "negative" veya "neutral",
        "title": "Rüyaya kısa, Türkçe başlık",
        "interpretation": "Gerçekçi ve psikolojik rüya yorumu (Türkçe)",
        "imagePrompt": "Cinematic digital art description in English..."
        }`,
        config: {
        responseSchema: {
            type: Type.OBJECT,
            properties: {
            sentiment: { type: Type.STRING, enum: ["positive", "negative", "neutral"] },
            title: { type: Type.STRING },
            interpretation: { type: Type.STRING },
            imagePrompt: { type: Type.STRING }
            }
        },
        safetySettings: SAFETY_SETTINGS
        }
    }));

    const rawText = response.text || "";
    try {
        const data = extractJSON(rawText);
        if (!data.interpretation) data.interpretation = rawText;
        if (!data.title) data.title = "Rüya Analizi";
        if (!data.sentiment) data.sentiment = "neutral";
        if (!data.imagePrompt) data.imagePrompt = "A surreal dreamscape, psychological depth, symbolic art, cinematic lighting, 8k resolution";
        return data as DreamAnalysis;
    } catch (jsonError) {
        return {
            sentiment: 'neutral',
            title: 'Rüya Analizi',
            interpretation: rawText.replace(/```json|```/g, '').trim(),
            imagePrompt: "A surreal dreamscape, psychological depth, symbolic art, cinematic lighting, 8k resolution"
        };
    }
  } catch (error: any) {
    throw new Error(`Rüya tabir edilirken hata: ${error.message}`);
  }
};

// 3. Generate Image
export const generateDreamImage = async (imagePrompt: string): Promise<string> => {
  // Prompt zaten İngilizce ve güvenli olarak analiz aşamasında üretildi.
  const finalPrompt = `${imagePrompt}, digital art, highly detailed, surrealism but clear, 8k resolution.`;

  console.log("Generating image with prompt:", finalPrompt);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
        // ÖNEMLİ: Görsel modeline (gemini-2.5-flash-image) safetySettings GÖNDERME.
        // Bazı platformlarda metin tabanlı güvenlik ayarları görsel modelinde "Invalid Argument" hatası verebilir.
        // Ayrıca aspectRatio'yu 16:9 olarak ayarla.
        const response = await withTimeout(ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: [{ text: finalPrompt }] },
            config: {
                // safetySettings: [], // Bilerek boş bırakıldı veya gönderilmedi.
                imageConfig: {
                    aspectRatio: "16:9"
                }
            }
        }), 45000);

        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
                return `data:image/png;base64,${part.inlineData.data}`;
            }
        }
    } catch (e: any) {
        console.error(`Image gen attempt ${attempt + 1} failed:`, e);
        if (attempt === 1) return ""; // Başarısız olursa boş string dön (App.tsx bunu handle eder)
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  return "";
};

// 4. Text to Speech (Chunk Based)
export const generateDreamSpeech = async (textChunk: string): Promise<AudioData> => {
  // API limiti için güvenlik
  const safeText = textChunk.length > 800 ? textChunk.substring(0, 800) : textChunk;

  try {
    const response = await withTimeout(ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: safeText }] }],
        config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
            voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' }, 
            },
        },
        safetySettings: SAFETY_SETTINGS
        },
    }), 60000); 

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("API'den ses verisi dönmedi.");

    const binaryString = atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    const buffer = bytes.buffer;
    const pcm16 = new Int16Array(buffer, 0, Math.floor(bytes.length / 2));
    const float32 = new Float32Array(pcm16.length);
    
    for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768.0;
    }

    return {
        audioData: float32,
        sampleRate: 24000
    };
  } catch (e) {
      console.error("TTS Chunk Failed:", e);
      throw e;
  }
};

// 5. Keyword Chat
export const askKeywordQuestion = async (
  dreamText: string, 
  interpretation: string, 
  question: string, 
  history: {role: string, parts: {text: string}[]}[]
): Promise<string> => {
  
  const systemInstruction = `Sen Süpürge Otu adında rüya analistisin. Rüya: "${dreamText}". Analiz: "${interpretation}". Soruya kısa, gerçekçi, psikolojik analiz içeren ve çözüm odaklı cevap ver. Mistik konuşma.`;

  try {
    const chat = ai.chats.create({
      model: 'gemini-2.5-flash',
      config: { systemInstruction, safetySettings: SAFETY_SETTINGS },
      history: history as any
    });

    const response = await withTimeout(chat.sendMessage({ message: question }));
    return response.text || "Şu an cevap veremiyorum.";
  } catch (e) {
      return "Bir hata oluştu.";
  }
};
