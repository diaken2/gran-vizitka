import mongoose from 'mongoose'
const entrySchema = new mongoose.Schema({
  date: String,
  verifier: String,
  customer:String,
  model: String,
  serial: String,
  year: String,
  maxD: String,
  registry: String,
  mp: String,
  location: String,
  certificate: String,
  photo1Url: String,
  photo2Url: String,
  createdBy: String,
  createdAt: {
    type: Date,
    default: Date.now,
  }
})

export default mongoose.model('Entry', entrySchema);