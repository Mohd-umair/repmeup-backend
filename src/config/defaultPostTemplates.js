/**
 * Starter post templates shipped with the platform.
 * canvasState stores a JSON representation of Fabric.js objects
 * that the frontend editor can load.
 */
module.exports = [
  {
    name: 'Product Showcase',
    category: 'product_showcase',
    description: 'Large product image, brand colors, price badge, CTA button.',
    aspectRatio: '1:1',
    isGlobal: true,
    canvasState: {
      backgroundColor: '#1A1A2E',
      objects: [
        {
          type: 'textbox',
          text: 'PRODUCT NAME',
          left: 540, top: 180, originX: 'center', originY: 'center',
          width: 800, fontSize: 56, fontWeight: 'bold', fontFamily: 'Inter',
          fill: '#FFFFFF', textAlign: 'center'
        },
        {
          type: 'textbox',
          text: '$99.99',
          left: 540, top: 800, originX: 'center', originY: 'center',
          width: 300, fontSize: 44, fontWeight: 'bold', fontFamily: 'Inter',
          fill: '#B8F567', textAlign: 'center'
        },
        {
          type: 'textbox',
          text: 'Shop Now →',
          left: 540, top: 920, originX: 'center', originY: 'center',
          width: 250, fontSize: 24, fontWeight: 'bold', fontFamily: 'Inter',
          fill: '#1A1A2E', textAlign: 'center',
          backgroundColor: '#B8F567', padding: 14
        }
      ]
    }
  },
  {
    name: 'Quote / Testimonial',
    category: 'quote',
    description: 'Text-heavy, subtle background, customer quote, brand logo.',
    aspectRatio: '1:1',
    isGlobal: true,
    canvasState: {
      backgroundColor: '#F5F5F5',
      objects: [
        {
          type: 'textbox',
          text: '"Your inspiring quote or customer testimonial goes here."',
          left: 540, top: 440, originX: 'center', originY: 'center',
          width: 850, fontSize: 40, fontWeight: '500', fontFamily: 'Playfair Display',
          fill: '#1A1A2E', textAlign: 'center', lineHeight: 1.5
        },
        {
          type: 'textbox',
          text: '— Customer Name',
          left: 540, top: 640, originX: 'center', originY: 'center',
          width: 400, fontSize: 22, fontWeight: '400', fontFamily: 'Inter',
          fill: '#666666', textAlign: 'center'
        }
      ]
    }
  },
  {
    name: 'Announcement',
    category: 'announcement',
    description: 'Bold headline, supporting text, event date, CTA.',
    aspectRatio: '1:1',
    isGlobal: true,
    canvasState: {
      backgroundColor: '#0F0F23',
      objects: [
        {
          type: 'textbox',
          text: 'BIG NEWS',
          left: 540, top: 280, originX: 'center', originY: 'center',
          width: 800, fontSize: 80, fontWeight: 'bold', fontFamily: 'Inter',
          fill: '#B8F567', textAlign: 'center'
        },
        {
          type: 'textbox',
          text: 'We are launching something amazing.\nStay tuned for the big reveal.',
          left: 540, top: 500, originX: 'center', originY: 'center',
          width: 800, fontSize: 28, fontWeight: '400', fontFamily: 'Inter',
          fill: '#CCCCCC', textAlign: 'center', lineHeight: 1.6
        },
        {
          type: 'textbox',
          text: 'Coming April 2026',
          left: 540, top: 700, originX: 'center', originY: 'center',
          width: 400, fontSize: 24, fontWeight: 'bold', fontFamily: 'Inter',
          fill: '#FFFFFF', textAlign: 'center'
        }
      ]
    }
  },
  {
    name: 'Behind the Scenes',
    category: 'behind_the_scenes',
    description: 'Minimal overlay, small caption, Instagram-native feel.',
    aspectRatio: '4:5',
    isGlobal: true,
    canvasState: {
      backgroundColor: '#222222',
      objects: [
        {
          type: 'textbox',
          text: 'Behind the scenes ✨',
          left: 540, top: 1200, originX: 'center', originY: 'center',
          width: 800, fontSize: 36, fontWeight: '600', fontFamily: 'Inter',
          fill: '#FFFFFF', textAlign: 'center',
          shadow: { color: 'rgba(0,0,0,0.6)', blur: 12, offsetX: 0, offsetY: 2 }
        }
      ]
    }
  },
  {
    name: 'Story / Reel Cover',
    category: 'story_cover',
    description: 'Vertical format, large text, engaging hook.',
    aspectRatio: '9:16',
    isGlobal: true,
    canvasState: {
      backgroundColor: '#0A0A1A',
      objects: [
        {
          type: 'textbox',
          text: 'WATCH\nTHIS',
          left: 540, top: 700, originX: 'center', originY: 'center',
          width: 800, fontSize: 120, fontWeight: 'bold', fontFamily: 'Inter',
          fill: '#FFFFFF', textAlign: 'center', lineHeight: 1.1
        },
        {
          type: 'textbox',
          text: 'Swipe up for the full story →',
          left: 540, top: 1600, originX: 'center', originY: 'center',
          width: 700, fontSize: 24, fontWeight: '500', fontFamily: 'Inter',
          fill: '#B8F567', textAlign: 'center'
        }
      ]
    }
  }
];
