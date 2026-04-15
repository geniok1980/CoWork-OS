/**
 * Geniok AI - Telegram Bot
 * AI Super App: ChatGPT, Claude, Gemini, Image/Video Generation
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '/root/CoWork-OS/syntax-bot/.env' });
import { Bot, InputFile } from "grammy";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import https from "https";
import http from "http";

// Configuration
const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "gpt-4o",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-3-5-sonnet-20241022",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: "gemini-2.0-flash",
  },
  music: {
    // Mubert API (free tier available at https://mubert.com)
    mubertToken: process.env.MUBERT_TOKEN || "",
  },
};

// Initialize AI clients
const openai = config.openai.apiKey 
  ? new OpenAI({ apiKey: config.openai.apiKey })
  : null;

const anthropic = config.anthropic.apiKey
  ? new Anthropic({ apiKey: config.anthropic.apiKey })
  : null;

const gemini = config.gemini.apiKey
  ? new GoogleGenerativeAI(config.gemini.apiKey)
  : null;

// Initialize Telegram Bot
const bot = new Bot(config.telegram.token);

// User session storage (in production, use Redis/DB)
const userSessions = new Map();

// Command: /start
bot.command("start", async (ctx) => {
  const welcome = `
🤖 <b>Geniok AI</b>

Ваш AI ассистент в Telegram!

Выберите действие или просто напишите сообщение!
  `;
  
  await ctx.reply(welcome, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 Чат с GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Чат с Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Чат с Gemini", callback_data: "model_gemini" },
          { text: "🎵 Генерация музыки", callback_data: "music_gen" }
        ],
        [
          { text: "🎨 Изображения", callback_data: "image_gen" },
          { text: "⚙️ Настройки", callback_data: "settings" }
        ],
        [
          { text: "📖 Помощь", callback_data: "help" }
        ]
      ]
    }
  });
});

// Command: /help
bot.command("help", async (ctx) => {
  const help = `
<b>📖 Справка по Geniok AI</b>

<b>AI Модели:</b>
• GPT-4o - Универсальный, быстрый
• Claude 3.5 - Лучший для кода и анализа
• Gemini 2.0 - Google's AI

<b>Генерация музыки:</b>
/music &lt;описание&gt; - создать музыку
Пример: /music relaxing piano ambient

<b>Как использовать:</b>
Просто напишите вопрос боту!
  `;
  
  await ctx.reply(help, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini", callback_data: "model_gemini" },
          { text: "🎵 Музыка", callback_data: "music_gen" }
        ],
        [
          { text: "🔄 Сменить модель", callback_data: "settings" }
        ]
      ]
    }
  });
});

// Command: /music (generate music)
bot.command("music", async (ctx) => {
  const args = ctx.message.text.replace("/music", "").trim();
  
  if (!args) {
    await ctx.reply(`
🎵 <b>Генерация музыки</b>

Использование: /music &lt;описание&gt;

<b>Примеры:</b>
/music relaxing ambient piano
/music energetic electronic dance
/music calm lofi hip hop
/music dramatic orchestral

<b>Стили:</b>
• ambient, electronic, rock, jazz, classical
• lofi, hiphop, pop, folk, metal
  `, { parse_mode: "HTML" });
    return;
  }
  
  await ctx.replyWithChatAction("upload_document");
  
  try {
    await ctx.reply(`🎵 <b>Генерация музыки...</b>

Запрос: ${args}
⏳ Подождите 10-30 секунд...`, { parse_mode: "HTML" });
    
    const musicUrl = await generateMusic(args, ctx);
    
    if (musicUrl) {
      await ctx.replyWithAudio(musicUrl, {
        caption: `🎵 <b>Ваша музыка!</b>

📝 Запрос: ${args}

Используйте /music &lt;описание&gt; для новой генерации`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎵 Ещё музыку", callback_data: "music_gen" }]
          ]
        }
      });
    } else {
      await ctx.reply(`
❌ <b>Генерация временно недоступна</b>

Попробуйте позже или опишите музыку иначе.

🎵 <b>Поддерживаемые стили:</b>
am • ambient • electronic • rock • jazz • classical
lofi • hiphop • pop • folk • metal • piano • orchestral
      `, { 
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Попробовать снова", callback_data: "music_gen" }]
          ]
        }
      });
    }
  } catch (error) {
    console.error("Music generation error:", error);
    await ctx.reply("❌ Ошибка при генерации музыки. Попробуйте позже.");
  }
});

// Command: /settings
bot.command("settings", async (ctx) => {
  const model = userSessions.get(ctx.from.id)?.model || "GPT-4o";
  
  const settings = `
<b>⚙️ Настройки</b>

<b>Текущая модель:</b> ${model}

<b>Выберите модель:</b>
  `;
  
  await ctx.reply(settings, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude 3.5", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini 2.0", callback_data: "model_gemini" }
        ],
        [
          { text: "🔙 Назад", callback_data: "back_to_start" }
        ]
      ]
    }
  });
});

// Command: /model
bot.command("model", async (ctx) => {
  const model = userSessions.get(ctx.from.id)?.model || "GPT-4o";
  
  const modelSelect = `
<b>🤖 Выбор AI модели</b>

<b>Текущая:</b> ${model}
  `;
  
  await ctx.reply(modelSelect, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude 3.5", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini 2.0", callback_data: "model_gemini" }
        ]
      ]
    }
  });
});

// Command: /chat (switch to GPT)
bot.command("chat", async (ctx) => {
  const session = userSessions.get(ctx.from.id) || {};
  session.model = "GPT-4o";
  userSessions.set(ctx.from.id, session);
  await ctx.reply("✅ <b>Модель:</b> GPT-4o", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini", callback_data: "model_gemini" }
        ]
      ]
    }
  });
});

// Command: /claude (switch to Claude)
bot.command("claude", async (ctx) => {
  if (!anthropic) {
    await ctx.reply("❌ Claude не настроен. Добавьте ANTHROPIC_API_KEY");
    return;
  }
  
  const session = userSessions.get(ctx.from.id) || {};
  session.model = "Claude";
  userSessions.set(ctx.from.id, session);
  await ctx.reply("✅ <b>Модель:</b> Claude 3.5 Sonnet", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini", callback_data: "model_gemini" }
        ]
      ]
    }
  });
});

// Command: /gemini (switch to Gemini)
bot.command("gemini", async (ctx) => {
  if (!gemini) {
    await ctx.reply("❌ Gemini не настроен. Добавьте GEMINI_API_KEY");
    return;
  }
  
  const session = userSessions.get(ctx.from.id) || {};
  session.model = "Gemini";
  userSessions.set(ctx.from.id, session);
  await ctx.reply("✅ <b>Модель:</b> Gemini 2.0 Flash", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini", callback_data: "model_gemini" }
        ]
      ]
    }
  });
});

// Handle all text messages
bot.on("message", async (ctx) => {
  // Ignore commands (they're handled above)
  if (ctx.message.text.startsWith("/")) {
    return;
  }
  
  const userId = ctx.from.id;
  const message = ctx.message.text;
  const session = userSessions.get(userId) || { model: "GPT-4o" };
  
  // Send "typing" indicator
  await ctx.replyWithChatAction("typing");
  
  try {
    let response;
    
    switch (session.model) {
      case "Claude":
        response = await chatWithClaude(message, ctx);
        break;
      case "Gemini":
        response = await chatWithGemini(message, ctx);
        break;
      default:
        response = await chatWithGPT(message, ctx);
    }
    
    // Reply with inline buttons
    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "💬 GPT-4o", callback_data: "model_gpt" },
            { text: "🧠 Claude", callback_data: "model_claude" },
            { text: "✨ Gemini", callback_data: "model_gemini" }
          ],
          [
            { text: "🔄 Новая модель", callback_data: "settings" },
            { text: "📖 Помощь", callback_data: "help" }
          ]
        ]
      }
    });
    
  } catch (error) {
    console.error("AI Error:", error);
    await ctx.reply("❌ Произошла ошибка. Попробуйте позже.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Попробовать снова", callback_data: "retry" }]
        ]
      }
    });
  }
});

// Handle callback queries (inline button presses)
bot.on("callback_query", async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  const session = userSessions.get(ctx.from.id) || { model: "GPT-4o" };
  
  switch (callbackData) {
    case "model_gpt":
      session.model = "GPT-4o";
      userSessions.set(ctx.from.id, session);
      await ctx.answerCallbackQuery("✅ GPT-4o выбран!");
      await ctx.editMessageReplyMarkup({
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 GPT-4o ✅", callback_data: "model_gpt" }]
          ]
        }
      });
      break;
      
    case "model_claude":
      if (!anthropic) {
        await ctx.answerCallbackQuery("❌ Claude не настроен", { show_alert: true });
        return;
      }
      session.model = "Claude";
      userSessions.set(ctx.from.id, session);
      await ctx.answerCallbackQuery("✅ Claude 3.5 выбран!");
      await ctx.editMessageReplyMarkup({
        reply_markup: {
          inline_keyboard: [
            [{ text: "🧠 Claude ✅", callback_data: "model_claude" }]
          ]
        }
      });
      break;
      
    case "model_gemini":
      if (!gemini) {
        await ctx.answerCallbackQuery("❌ Gemini не настроен", { show_alert: true });
        return;
      }
      session.model = "Gemini";
      userSessions.set(ctx.from.id, session);
      await ctx.answerCallbackQuery("✅ Gemini 2.0 выбран!");
      await ctx.editMessageReplyMarkup({
        reply_markup: {
          inline_keyboard: [
            [{ text: "✨ Gemini ✅", callback_data: "model_gemini" }]
          ]
        }
      });
      break;
      
    case "settings":
      await ctx.answerCallbackQuery("⚙️ Настройки");
      const settings = `
<b>⚙️ Выберите модель</b>

<b>Текущая:</b> ${session.model}
      `;
      await ctx.editMessageText(settings, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Claude 3.5", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Gemini 2.0", callback_data: "model_gemini" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "help":
      await ctx.answerCallbackQuery("📖 Помощь");
      const help = `
<b>📖 Справка по Geniok AI</b>

<b>AI Модели:</b>
• GPT-4o - Универсальный, быстрый
• Claude 3.5 - Лучший для кода и анализа
• Gemini 2.0 - Google's AI

<b>Как использовать:</b>
Просто напишите вопрос боту!
      `;
      await ctx.editMessageText(help, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Claude", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Gemini", callback_data: "model_gemini" }
            ],
            [
              { text: "🔄 Сменить модель", callback_data: "settings" }
            ]
          ]
        }
      });
      break;
      
    case "back_to_start":
      await ctx.answerCallbackQuery("🏠 Главное меню");
      const welcome = `
🤖 <b>Geniok AI</b>

Ваш AI ассистент в Telegram!

Выберите действие или просто напишите сообщение!
      `;
      await ctx.editMessageText(welcome, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 Чат с GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Чат с Claude", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Чат с Gemini", callback_data: "model_gemini" },
              { text: "⚙️ Настройки", callback_data: "settings" }
            ],
            [
              { text: "📖 Помощь", callback_data: "help" },
              { text: "🎨 Генерация изображений", callback_data: "image_gen" }
            ]
          ]
        }
      });
      break;
      
    case "image_gen":
      await ctx.answerCallbackQuery("🎨 Генерация изображений", { show_alert: true });
      await ctx.editMessageText(`
🎨 <b>Генерация изображений</b>

<b>Доступно скоро!</b>

Пока используйте текстовое описание для генерации идей.

<i>Пример: "Нарисуй красивый закат над океаном в стиле импрессионизма"</i>

Или попробуйте /imagine &lt;описание&gt;
      `, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Назад", callback_data: "back_to_start" }]
          ]
        }
      });
      break;
      
    case "music_gen":
      await ctx.answerCallbackQuery("🎵 Генерация музыки");
      const musicHelp = `
🎵 <b>Генерация музыки</b>

<b>Использование:</b>
/music &lt;описание&gt;

<b>Примеры:</b>
/music relaxing ambient piano
/music energetic electronic dance
/music calm lofi hip hop
/music dramatic orchestral

<b>Стили:</b>
am • ambient • electronic • rock • jazz
lofi • hiphop • pop • folk • metal
piano • orchestral • chill • upbeat
      `;
      await ctx.editMessageText(musicHelp, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎹 Ambient", callback_data: "music_ambient" },
              { text: "🎸 Rock", callback_data: "music_rock" }
            ],
            [
              { text: "🎹 Lofi", callback_data: "music_lofi" },
              { text: "🎻 Classical", callback_data: "music_classical" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "music_ambient":
      await ctx.answerCallbackQuery("🎹 Ambient music");
      await ctx.replyWithChatAction("upload_document");
      const ambientMusic = await generateMusic("ambient relaxing chill nature sounds", ctx);
      if (ambientMusic) {
        await ctx.replyWithAudio(ambientMusic, {
          caption: `🎹 <b>Ambient Music</b>

Стиль: Relaxing ambient

/music &lt;описание&gt; - новая генерация`,
          parse_mode: "HTML"
        });
      } else {
        await ctx.reply("❌ Генерация недоступна. Попробуйте позже.");
      }
      break;
      
    case "music_rock":
      await ctx.answerCallbackQuery("🎸 Rock music");
      await ctx.replyWithChatAction("upload_document");
      const rockMusic = await generateMusic("energetic rock guitar drums", ctx);
      if (rockMusic) {
        await ctx.replyWithAudio(rockMusic, {
          caption: `🎸 <b>Rock Music</b>

Стиль: Energetic rock

/music &lt;описание&gt; - новая генерация`,
          parse_mode: "HTML"
        });
      } else {
        await ctx.reply("❌ Генерация недоступна. Попробуйте позже.");
      }
      break;
      
    case "music_lofi":
      await ctx.answerCallbackQuery("🎹 Lofi music");
      await ctx.replyWithChatAction("upload_document");
      const lofiMusic = await generateMusic("lofi hip hop chill beats", ctx);
      if (lofiMusic) {
        await ctx.replyWithAudio(lofiMusic, {
          caption: `🎹 <b>Lofi Music</b>

Стиль: Chill lofi beats

/music &lt;описание&gt; - новая генерация`,
          parse_mode: "HTML"
        });
      } else {
        await ctx.reply("❌ Генерация недоступна. Попробуйте позже.");
      }
      break;
      
    case "music_classical":
      await ctx.answerCallbackQuery("🎻 Classical music");
      await ctx.replyWithChatAction("upload_document");
      const classicalMusic = await generateMusic("classical orchestral symphony piano", ctx);
      if (classicalMusic) {
        await ctx.replyWithAudio(classicalMusic, {
          caption: `🎻 <b>Classical Music</b>

Стиль: Orchestral symphony

/music &lt;описание&gt; - новая генерация`,
          parse_mode: "HTML"
        });
      } else {
        await ctx.reply("❌ Генерация недоступна. Попробуйте позже.");
      }
      break;
      
    case "retry":
      await ctx.answerCallbackQuery("🔄 Попробуйте отправить сообщение ещё раз");
      break;
      
    default:
      await ctx.answerCallbackQuery("Неизвестная команда");
  }
});

// GPT-4o chat
async function chatWithGPT(message, ctx) {
  if (!openai) {
    return "❌ OpenAI не настроен. Добавьте OPENAI_API_KEY";
  }
  
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `Ты - Geniok AI, дружелюбный AI ассистент. 
Отвечай на русском языке.
Будь полезным, вежливым и информативным.
Используй форматирование HTML где уместно (<b>жирный</b>, <i>курсив</i>).`
      },
      {
        role: "user",
        content: message
      }
    ],
    max_tokens: 2000,
  });
  
  return response.choices[0].message.content;
}

// Claude chat
async function chatWithClaude(message, ctx) {
  if (!anthropic) {
    return "❌ Claude не настроен.";
  }
  
  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 2000,
    system: `Ты - Geniok AI, дружелюбный AI ассистент. 
Отвечай на русском языке.
Будь полезным, вежливым и информативным.`,
    messages: [
      {
        role: "user",
        content: message
      }
    ]
  });
  
  return response.content[0].type === 'text' 
    ? response.content[0].text 
    : "❌ Не удалось получить ответ";
}

// Gemini chat
async function chatWithGemini(message, ctx) {
  if (!gemini) {
    return "❌ Gemini не настроен.";
  }
  
  const model = gemini.getGenerativeModel({ 
    model: "gemini-2.0-flash",
    systemInstruction: `Ты - Geniok AI, дружелюбный AI ассистент. 
Отвечай на русском языке.
Будь полезным, вежливым и информативным.`
  });
  
  const result = await model.generateContent(message);
  const response = await result.response;
  
  return response.text() || "❌ Не удалось получить ответ";
}

// Music generation using Mubert API
async function generateMusic(prompt, ctx) {
  try {
    // Try using Mubert API if token is available
    if (config.music.mubertToken) {
      return await generateWithMubert(prompt);
    }
    
    // For now, return null to indicate music generation is not fully configured
    // In production, integrate with Suno, Udio, or Mubert API
    console.log("Music generation requested:", prompt);
    return null;
    
  } catch (error) {
    console.error("Music generation error:", error);
    return null;
  }
}

// Mubert API integration
async function generateWithMubert(prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      method: "RecordTrackTT",
      params: {
        pat: config.music.mubertToken,
        duration: 30,
        tags: prompt.substring(0, 50),
        format: "mp3"
      }
    });
    
    const options = {
      hostname: "api.mubert.com",
      port: 443,
      path: "/v2/RecordTrackTT",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length
      }
    };
    
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          const response = JSON.parse(body);
          if (response.data && response.data.tasks && response.data.tasks[0]) {
            resolve(response.data.tasks[0].download_link);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });
    
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Error handler
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Start bot
console.log("🚀 Geniok AI starting...");

if (!config.telegram.token) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set!");
  console.log("\n📝 To get a token:");
  console.log("1. Open Telegram and search for @BotFather");
  console.log("2. Send /newbot");
  console.log("3. Follow instructions");
  console.log("4. Copy token and set: export TELEGRAM_BOT_TOKEN='your_token'");
  process.exit(1);
}

bot.start();
console.log("✅ Geniok AI started!");
console.log("\n📋 Available features:");
if (openai) console.log("  ✅ GPT-4o");
else console.log("  ❌ GPT-4o (need OPENAI_API_KEY)");
if (anthropic) console.log("  ✅ Claude 3.5");
else console.log("  ❌ Claude (need ANTHROPIC_API_KEY)");
if (gemini) console.log("  ✅ Gemini 2.0");
else console.log("  ❌ Gemini (need GEMINI_API_KEY)");
if (config.music.mubertToken) console.log("  ✅ Music (Mubert)");
else console.log("  ⚠️ Music (need MUBERT_TOKEN for full functionality)");
console.log("\n🎵 Music commands:");
console.log("  /music <description> - Generate music");
console.log("  Example: /music relaxing ambient piano");
