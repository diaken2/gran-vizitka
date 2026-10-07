// server.js
import "dotenv/config"; // должен быть первым: загружает переменные из .env
import express from "express";
import path from "path"
import { fileURLToPath } from "url"
import cors from "cors";
import mongoose from "mongoose";
import router from "./router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename)

const app = express();

// Middleware ДО статических файлов
app.use(cors());
app.use(express.json());
app.use("/api", router);

// Статические файлы: собранный React-сайт (кладётся сюда командой npm run build в клиенте)
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

// SPA fallback - ПОСЛЕДНИМ: любые другие адреса (/table, /admin и т.д.) открывают
// React-приложение, а нужную страницу дальше показывает React Router.
// Запросы к /api сюда не попадают — для неизвестного API-адреса будет обычная 404.
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 8886;

const start = async () => {
  if (!process.env.MONGO_URI) {
    console.log("MONGO_URI не задан. Создайте файл .env по образцу .env.example");
    return;
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, {});
    app.listen(PORT, () => {
      console.log("Server has been launched on PORT:", PORT);
    });
  } catch (e) {
    console.log(e.message);
    return;
  }
};

start();