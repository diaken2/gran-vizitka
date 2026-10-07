// router.js
import express from 'express'
import Content from './models/Content.js'
import multer from 'multer'
import Entry from "./models/Entry.js";
import User from './models/User.js'
import bcrypt from 'bcrypt'
import axios from "axios"
import FormData from 'form-data';
import ConvertedEntry from './models/ConvertedEntry.js'


const router = express.Router()

// Настройка multer для загрузки файлов
const storage = multer.memoryStorage()
const upload = multer({ storage })

// ===== ЗАГРУЗКА ФОТО (ImageBan) =====
// ImageBan больше не принимает гостевую загрузку по CLIENT_ID ("TOKEN ...") —
// теперь только "Authorization: Bearer <SECRET_KEY>". Секретный ключ нельзя
// держать во фронтенде, поэтому фото идёт через наш сервер.
const MAX_PHOTO_SIZE = 10 * 1024 * 1024 // лимит ImageBan для обычного аккаунта

const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_SIZE },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Файл не является изображением'))
    }
    cb(null, true)
  },
})

router.post('/upload-photo', (req, res) => {
  uploadPhoto.single('image')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 10 МБ' : err.message
      return res.status(400).json({ error: message })
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не получен' })
    }

    const secretKey = process.env.IMAGEBAN_SECRET_KEY
    if (!secretKey) {
      console.error('IMAGEBAN_SECRET_KEY не задан в .env')
      return res.status(500).json({ error: 'Загрузка фото не настроена на сервере' })
    }

    try {
      const form = new FormData()
      // Имя файла — латиницей: кириллица из браузера приходит в multer искажённой
      const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
      form.append('image', req.file.buffer, {
        filename: `photo-${Date.now()}.${ext}`,
        contentType: req.file.mimetype,
      })

      const { data } = await axios.post('https://api.imageban.ru/v1', form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${secretKey}` },
        maxBodyLength: Infinity,
        timeout: 60000,
        validateStatus: () => true, // ImageBan отдаёт ошибки и с кодом 200 — разбираем тело сами
      })

      const link = Array.isArray(data?.data) ? data.data[0]?.link : data?.data?.link
      if (data?.success && link) {
        return res.json({ url: link })
      }

      console.error('ImageBan вернул ошибку:', JSON.stringify(data))
      return res.status(502).json({
        error: `ImageBan: ${data?.error?.message || 'не вернул ссылку'}`,
        code: data?.error?.code,
      })
    } catch (e) {
      console.error('Запрос к ImageBan не прошёл:', e.message)
      return res.status(502).json({ error: 'Не удалось связаться с ImageBan' })
    }
  })
})

// ===== CONTENT ROUTES =====

// Получить контент для страницы
// router.js - GET роут
// router.js - GET роут
// router.js - добавьте временный роут для исправления порядка
// router.js - ДОБАВЬТЕ ЭТОТ РОУТ ДЛЯ ПРОВЕРКИ
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadToImageBan(url, entryIndex, totalEntries, fieldName) {
  console.log(`\n[${entryIndex}/${totalEntries}] Uploading ${fieldName}: ${url}`);

  try {
    const form = new FormData();
    form.append("url", url);

    const response = await axios.post(
      "https://api.imageban.ru/v1",
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.IMAGEBAN_SECRET_KEY}`
        }
      }
    );

    const link = response.data?.data?.link;

    if (link) {
      console.log(`[${entryIndex}/${totalEntries}] SUCCESS → ${link}`);
      return link;
    }

    console.log(`[${entryIndex}/${totalEntries}] ERROR (no link):`, response.data);
    return null;

  } catch (err) {
    console.log(
      `[${entryIndex}/${totalEntries}] ERROR uploading ${fieldName}:`,
      err.response?.data || err.message
    );
    return null;
  }
}

async function uploadToImageBanWithRetry(url, entryIndex, totalEntries, fieldName) {
  let attempts = 3;

  while (attempts > 0) {
    const result = await uploadToImageBan(url, entryIndex, totalEntries, fieldName);

    if (result) return result;

    attempts--;

    console.log(`[${entryIndex}/${totalEntries}] RETRYING ${fieldName}... (${3 - attempts}/3)`);

    await wait(4000); // пауза между попытками
  }

  console.log(`[${entryIndex}/${totalEntries}] FAILED after 3 attempts`);
  return null;
}
router.get('/save_converted_entries', async (req, res) => {
  try {
    if (!Array.isArray(convertedEntriesArray) || convertedEntriesArray.length === 0) {
      return res.status(400).json({ success: false, message: "convertedEntriesArray is empty" });
    }

    // очищаем _id и __v
    const cleaned = convertedEntriesArray.map(e => {
      const { _id, __v, ...rest } = e;
      return rest;
    });

    // вставляем
    await ConvertedEntry.insertMany(cleaned);

    res.json({
      success: true,
      inserted: cleaned.length,
      message: "Все записи успешно сохранены в новую коллекцию ConvertedEntry"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
router.get('/all-entries-json-converted', async (req, res) => {
  try {
    const entries = await ConvertedEntry.find().sort({ createdAt: -1 });
    const total = entries.length;

    console.log(`\n=== STARTING IMAGEBAN CONVERSION (${total} entries) ===\n`);

    const updatedEntries = [];

    let index = 1;

    for (const entry of entries) {
      const newEntry = entry.toObject();

      console.log(`\n===== ENTRY ${index}/${total} =====`);
      console.log(`ID: ${entry._id}`);

      // PHOTO 1
      if (newEntry.photo1Url) {
        newEntry.photo1Url =
          (await uploadToImageBanWithRetry(newEntry.photo1Url, index, total, "photo1")) ||
          newEntry.photo1Url;

        await wait(4000);
      } else {
        console.log(`[${index}/${total}] photo1: пусто — пропуск`);
      }

      // PHOTO 2
      if (newEntry.photo2Url) {
        newEntry.photo2Url =
          (await uploadToImageBanWithRetry(newEntry.photo2Url, index, total, "photo2")) ||
          newEntry.photo2Url;

        await wait(1000);
      } else {
        console.log(`[${index}/${total}] photo2: пусто — пропуск`);
      }

      updatedEntries.push(newEntry);
      index++;
    }

    console.log(`\n=== FINISHED IMAGEBAN CONVERSION ===\n`);

    res.json({
      success: true,
      count: updatedEntries.length,
      entries: updatedEntries
    });

  } catch (err) {
    console.log("\n=== ERROR IN ROUTE ===\n", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// Функция для обработки одного объекта
async function processEntry(entry) {
  const result = { ...entry._doc ? entry._doc : entry };
  
  // Обрабатываем photo1Url
  if (result.photo1Url && result.photo1Url.trim() !== '') {
    console.log(`Processing photo1Url for ${result._id}: ${result.photo1Url}`);
    const newUrl = await uploadToImageBan(result.photo1Url);
    if (newUrl) {
      result.photo1Url = newUrl;
      console.log(`Updated photo1Url: ${newUrl}`);
    } else {
      console.log(`Failed to upload photo1Url for ${result._id}`);
    }
  }
  
  // Обрабатываем photo2Url
  if (result.photo2Url && result.photo2Url.trim() !== '') {
    console.log(`Processing photo2Url for ${result._id}: ${result.photo2Url}`);
    const newUrl = await uploadToImageBan(result.photo2Url);
    if (newUrl) {
      result.photo2Url = newUrl;
      console.log(`Updated photo2Url: ${newUrl}`);
    } else {
      console.log(`Failed to upload photo2Url for ${result._id}`);
    }
  }
  
  return result;
}

// Маршрут для миграции всех записей
router.get('/migrate-images', async (req, res) => {
  try {
    // Получаем все записи
    const entries = await Entry.find().sort({ createdAt: -1 });
    
    console.log(`Found ${entries.length} entries to process`);
    
    // Массив для результатов
    const migratedEntries = [];
    
    // Обрабатываем каждую запись последовательно с задержкой
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      console.log(`Processing entry ${i + 1}/${entries.length}: ${entry._id}`);
      
      const migratedEntry = await processEntry(entry);
      migratedEntries.push(migratedEntry);
      
      // Добавляем задержку 1 секунду между запросами чтобы не превысить лимиты
      if (i < entries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    res.json({
      success: true,
      count: migratedEntries.length,
      entries: migratedEntries,
      message: `Successfully migrated ${migratedEntries.length} entries`
    });
    
  } catch (err) {
    console.error('Migration error:', err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});
router.get('/debug-content', async (req, res) => {
  const contents = await Content.find({ page: 'home' })
  res.json(contents.map(c => ({ section: c.section, order: c.order })))
})
// router.js - ДОБАВЬТЕ ЭТОТ ПРОСТОЙ РОУТ
router.post('/fix-orders-now', async (req, res) => {
  try {
    const sections = ['hero', 'navbar', 'header', 'what', '1899, Дирборн', 'order'];
    
    for (let i = 0; i < sections.length; i++) {
      await Content.updateOne(
        { page: 'home', section: sections[i] },
        { $set: { order: i } }
      );
      console.log(`✅ ${sections[i]} -> order=${i}`);
    }
    
    res.json({ success: true, message: 'Orders fixed!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const setDefaultOrder = async () => {
  const contents = await Content.find({});
  for (let i = 0; i < contents.length; i++) {
    contents[i].order = i;
    await contents[i].save();
  }
  console.log('Default order set for all documents');
};
// router.js - исправьте GET роут
router.get('/content/:page', async (req, res) => {
  try {
    console.log('GET /api/content/' + req.params.page)
    
    // ВАЖНО: всегда сортируем по полю order
    const content = await Content.find({ page: req.params.page }).sort({ order: 1 })
    
    console.log('📋 Found content items with order:')
    content.forEach(item => {
      console.log(`  - ${item.section}: order=${item.order}`)
    })
    
    const contentMap = {}
    content.forEach(item => {
      contentMap[item.section] = item.data
    })
    
    console.log('✅ Content map keys in order:', Object.keys(contentMap))
    res.json(contentMap)
  } catch (err) {
    console.error('Error fetching content:', err)
    res.status(500).json({ error: err.message })
  }
})

// Обновить контент секции
router.put('/content/:page/:section', async (req, res) => {
  try {
    const { page, section } = req.params
    console.log(`Updating content: ${page} -> ${section}`, req.body)
    
    const content = await Content.findOneAndUpdate(
      { page, section },
      { 
        page, 
        section, 
        data: req.body,
        updatedAt: new Date()
      },
      { upsert: true, new: true, runValidators: true }
    )
    console.log('Content updated successfully')
    res.json(content)
  } catch (err) {
    console.error('Error updating content:', err)
    res.status(500).json({ error: err.message })
  }
})

// Загрузка изображений через ImgBB
router.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    console.log('Uploading image...')
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    // Правильная загрузка в ImgBB
    const formData = new FormData()
    formData.append('image', req.file.buffer.toString('base64'))

    const imgbbResponse = await fetch(`https://api.imgbb.com/1/upload?key=dfc6fdfece532c32d930e5d0a1561fbd`, {
      method: 'POST',
      body: formData,
    })

    const imgbbData = await imgbbResponse.json()
    console.log('ImgBB upload result:', imgbbData.success)
    
    if (imgbbData.success) {
      res.json({ url: imgbbData.data.url })
    } else {
      res.status(500).json({ error: 'Upload to ImgBB failed' })
    }
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ===== СРОК ХРАНЕНИЯ ЗАПИСЕЙ =====
// По просьбе заказчика записи хранятся 2 года (раньше браузер удалял всё сверх 1500 строк).
// Записи старше срока удаляет сервер, когда сохраняется новая запись.
// Срок можно поменять без правки кода: RETENTION_MONTHS в .env (в месяцах).
const RETENTION_MONTHS = Number(process.env.RETENTION_MONTHS) || 24

async function deleteEntriesOlderThanRetention() {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS)

  // Удаляются только записи с датой создания раньше cutoff; записи без даты не трогаем
  const { deletedCount = 0 } = await ConvertedEntry.deleteMany({ createdAt: { $lt: cutoff } })
  if (deletedCount > 0) {
    console.log(`Удалено записей старше ${RETENTION_MONTHS} мес.: ${deletedCount}`)
  }
  return deletedCount
}

// ===== EXISTING ROUTES (ваши текущие роуты) =====

router.post('/entries', async (req, res) => {
  console.log('Получено')
  try {
    const entry = new ConvertedEntry(req.body)
    await entry.save()
    res.status(201).json(entry)
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  // Очистка — после ответа: запись уже сохранена, и ошибка очистки её не затронет
  deleteEntriesOlderThanRetention().catch((err) =>
    console.error('Ошибка удаления старых записей:', err.message)
  )
})

router.get('/created-users', async (req, res) => {
  try {
    const users = await User.find({}, '-passwordHash')
    res.json(users)
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки' })
  }
}) 

router.delete('/created-users/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id)
    res.json({ message: 'Пользователь удалён' })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' })
  }
})

router.get('/entries', async (req, res) => {
  console.log('Выведено')
  try {
    // Без лимита 1500: старые записи удаляются по сроку хранения (2 года)
    const entries = await ConvertedEntry.find().sort({ createdAt: -1 })
    res.status(200).json(entries)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(username,password)

  try {
    const user = await User.findOne({ username });

    if (!user || !(await user.verifyPassword(password))) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    res.json({
      userId: user._id,
      username: user.username,
      role: user.role,
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.get('/me/:id', async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' })
  res.json({ username: user.username, role: user.role })
})

router.post('/create-users', async (req, res) => {
  console.log('Процесс создания пользователя...')
  const { username, password, role } = req.body

  const passwordHash = await bcrypt.hash(password, 10)
  const user = new User({ username, passwordHash, role })

  try {
    await user.save()
    res.status(201).json({ message: 'Пользователь создан' })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Старое удаление «всё сверх 1500 строк» отключено. Роут оставлен пустым, чтобы
// старая версия сайта (если где-то открыта) не получила ошибку, — он ничего не удаляет.
router.delete('/entries/old', (req, res) => {
  res.status(200).json({ message: 'Удаление по количеству отключено, записи хранятся 2 года' })
})
router.get('/test', (req, res) => {
  res.json({ message: 'API is working!' });
});

router.get('/content/:page', async (req, res) => {
  try {
    console.log('GET /api/content/' + req.params.page);
    const content = await Content.find({ page: req.params.page });
    const contentMap = {};
    content.forEach(item => {
      contentMap[item.section] = item.data;
    });
    res.json(contentMap);
  } catch (err) {
    console.error('Error fetching content:', err);
    res.status(500).json({ error: err.message });
  }
});
// router.js - добавляем DELETE роут
router.delete('/content/:page/:section', async (req, res) => {
  try {
    const { page, section } = req.params
    console.log(`DELETE /api/content/${page}/${section}`)
    
    const result = await Content.findOneAndDelete({ page, section })
    
    if (!result) {
      return res.status(404).json({ error: 'Section not found' })
    }
    
    console.log('Section deleted successfully')
    res.json({ message: `Section ${section} deleted successfully` })
  } catch (err) {
    console.error('Error deleting section:', err)
    res.status(500).json({ error: err.message })
  }
})

router.get('/content/:page', async (req, res) => {
  try {
    console.log('GET /api/content/' + req.params.page)
    const content = await Content.find({ page: req.params.page }).sort({ order: 1 }) // СОРТИРОВКА ПО ORDER
    const contentMap = {}
    content.forEach(item => {
      contentMap[item.section] = {
        ...item.data,
        _order: item.order // Добавляем порядок в данные
      }
    })
    console.log('Content found:', Object.keys(contentMap))
    res.json(contentMap)
  } catch (err) {
    console.error('Error fetching content:', err)
    res.status(500).json({ error: err.message })
  }
})

// Обновить порядок секций
// Обновить порядок секций
// router.js - проверьте этот роут
// router.js - PUT /content/:page/order
// router.js - исправляем PUT /content/:page/order
// router.js - исправьте PUT /content/:page/order
// router.js - ПЕРЕПИШИТЕ роут обновления порядка
router.put('/content/:page/order', async (req, res) => {
  try {
    const { page } = req.params;
    const { sectionsOrder } = req.body;

    console.log('💣 ЯДЕРНОЕ СОХРАНЕНИЕ:', sectionsOrder);

    // УДАЛЯЕМ ВСЕ И СОЗДАЕМ ЗАНОВО
    await Content.deleteMany({ page });
    
    for (let i = 0; i < sectionsOrder.length; i++) {
      const sectionName = sectionsOrder[i];
      await Content.create({
        page,
        section: sectionName,
        order: i,
        data: {} // или какое-то дефолтное значение
      });
      console.log(`✅ CREATED: ${sectionName} -> ${i}`);
    }

    res.json({ success: true, message: 'NUKED AND RECREATED!' });
  } catch (err) {
    console.error('💥 ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});


// router.js - добавь новый роут
router.put('/reorder-sections/:page', async (req, res) => {
  try {
    const { page } = req.params;
    const { sectionsOrder } = req.body;

    console.log('💣 ЯДЕРНОЕ СОХРАНЕНИЕ ПОРЯДКА:', sectionsOrder);

    for (let i = 0; i < sectionsOrder.length; i++) {
      const sectionName = sectionsOrder[i];
      console.log(`📝 ${sectionName} -> order=${i}`);
      
      const result = await Content.updateOne(
        { page, section: sectionName },
        { $set: { order: i } }
      );
      console.log(`✅ Updated: ${sectionName}, modified: ${result.modifiedCount}`);
    }

    // Проверяем результат
    const updated = await Content.find({ page }).sort({ order: 1 });
    console.log('🎯 FINAL ORDER IN DATABASE:');
    updated.forEach(item => {
      console.log(`   ${item.section}: order=${item.order}`);
    });

    res.json({ success: true, message: 'Order saved!', finalOrder: updated.map(u => u.section) });
  } catch (err) {
    console.error('💥 ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});
// При создании новой секции устанавливаем порядок
// router.js - исправьте PUT /content/:page/:section
router.put('/content/:page/:section', async (req, res) => {
  try {
    const { page, section } = req.params;
    console.log(`PUT /api/content/${page}/${section}`, req.body);
    
    // Находим максимальный order для новой секции
    const maxOrderDoc = await Content.findOne({ page }).sort({ order: -1 });
    const newOrder = maxOrderDoc ? maxOrderDoc.order + 1 : 0;
    
    const content = await Content.findOneAndUpdate(
      { page, section },
      { 
        page, 
        section, 
        data: req.body,
        order: newOrder, // ВСЕГДА устанавливаем правильный order
        updatedAt: new Date()
      },
      { 
        upsert: true, 
        new: true, 
        runValidators: true 
      }
    );
    
    console.log('Content updated successfully with order:', newOrder);
    res.json(content);
  } catch (err) {
    console.error('Error updating content:', err);
    res.status(500).json({ error: err.message });
  }
});
// Обновить контент секции
router.put('/content/:page/:section', async (req, res) => {
  try {
    console.log(`PUT /api/content/${req.params.page}/${req.params.section}`, req.body);
    
    const { page, section } = req.params;
    const content = await Content.findOneAndUpdate(
      { page, section },
      { 
        page, 
        section, 
        data: req.body,
        updatedAt: new Date()
      },
      { 
        upsert: true, 
        new: true, 
        runValidators: true 
      }
    );
    
    console.log('Content updated successfully');
    res.json(content);
  } catch (err) {
    console.error('Error updating content:', err);
    res.status(500).json({ error: err.message });
  }
});
router.patch('/entries/:id', async (req, res) => {
  try {
    const entry = await ConvertedEntry.findByIdAndUpdate(req.params.id, req.body, { new: true })
    res.json(entry)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/entries/:id', async (req, res) => {
  try {
    await ConvertedEntry.findByIdAndDelete(req.params.id)
    res.json({ message: 'Запись удалена' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


router.get('/all-entries-json', async (req, res) => {
  try {
    const entries = await ConvertedEntry.find().sort({ createdAt: -1 })
    
    res.json({
      success: true,
      count: entries.length,
      entries: entries
    })
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: err.message 
    })
  }
})


export default router