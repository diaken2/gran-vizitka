// models/Content.js
import mongoose from 'mongoose'

const contentSchema = new mongoose.Schema({
  page: { 
    type: String, 
    required: true,
    index: true 
  },
  section: { 
    type: String, 
    required: true,
    index: true 
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  order: {
  type: Number,
  default: 0,
  required: true
},
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
})

contentSchema.index({ page: 1, section: 1 }, { unique: true })

export default mongoose.model('Content', contentSchema)