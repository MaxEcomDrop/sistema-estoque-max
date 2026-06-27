const express = require('express');
const productController = require('../controllers/productController');
const { authMiddleware } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/produtos/sync', authMiddleware, productController.syncProdutos);
router.get('/produtos', authMiddleware, productController.getProdutos);
router.get('/produtos/search', authMiddleware, productController.searchProdutos);
router.get('/produtos/:id', authMiddleware, productController.getProdutoById);
router.patch('/produtos/:id', authMiddleware, productController.updateProduto);

module.exports = router;
