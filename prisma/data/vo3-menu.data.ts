import type { MenuItemBadge } from '@prisma/client';

/**
 * VO3 Menu — approved real Kebda Zaman restaurant catalog (static data only,
 * no database access, no side effects). Imported exclusively by
 * prisma/seed.ts. Category order and item order within a category are the
 * approved display order — displayOrder is derived from array position, not
 * hand-numbered, so reordering this file is the only thing that changes it.
 */

export interface Vo3VariantSeed {
  key: string;
  nameAr: string;
  nameEn: string;
  priceDelta: number;
  isDefault: boolean;
}

export interface Vo3MenuItemSeed {
  key: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  basePrice: number;
  /** Omitted -> null (no discount). Must be greater than basePrice when set. */
  compareAtPrice?: number;
  /** Omitted -> null (unknown). */
  calories?: number;
  /** Omitted -> null (no badge). Manually assigned only; never inferred. */
  badge?: MenuItemBadge;
  variants?: Vo3VariantSeed[];
  /**
   * Approved "Often Ordered With" targets, as MenuItem keys (never variant
   * keys — a source referencing a specific variant, e.g. "Meat Hawawshi -
   * Large", resolves to its parent MenuItem key). Omitted -> no outgoing
   * recommendations. Max 3, in the approved display order, no self-reference,
   * no duplicate targets — enforced by validateVo3Recommendations() before
   * any database write.
   */
  recommendationKeys?: readonly string[];
}

export interface Vo3CategorySeed {
  key: string;
  nameAr: string;
  nameEn: string;
  items: Vo3MenuItemSeed[];
}

export const VO3_MENU: Vo3CategorySeed[] = [
  {
    key: 'beverages',
    nameAr: 'المشروبات',
    nameEn: 'Beverages',
    items: [
      {
        key: 'orange-mirinda',
        nameAr: 'ميرندا برتقال',
        nameEn: 'Orange Mirinda',
        descriptionAr: 'مشروب غازي منعش بنكهة البرتقال.',
        descriptionEn: 'Refreshing orange-flavoured soft drink.',
        basePrice: 4,
        recommendationKeys: ['seven-up', 'bread', 'green-salad'],
      },
      {
        key: 'pepsi',
        nameAr: 'بيبسي',
        nameEn: 'Pepsi',
        descriptionAr: 'مشروب غازي منعش.',
        descriptionEn: 'Refreshing carbonated soft drink.',
        basePrice: 4,
        calories: 172,
        recommendationKeys: ['green-salad', 'water', 'tahinah'],
      },
      {
        key: 'seven-up',
        nameAr: 'سفن أب',
        nameEn: '7 Up',
        descriptionAr: 'مشروب غازي منعش بنكهة الليمون واللايم.',
        descriptionEn: 'A crisp and refreshing lemon-lime soft drink.',
        basePrice: 4,
        calories: 89,
        recommendationKeys: ['pepsi', 'kinza', 'water'],
      },
      {
        key: 'water',
        nameAr: 'مياه',
        nameEn: 'Water',
        descriptionAr: 'مياه معدنية معبأة.',
        descriptionEn: 'Bottled mineral water.',
        basePrice: 1,
        calories: 1,
      },
      {
        key: 'kinza',
        nameAr: 'كينزا',
        nameEn: 'Kinza',
        descriptionAr: 'مشروب غازي مصنوع في المملكة العربية السعودية.',
        descriptionEn: 'A soft drink made in Saudi Arabia.',
        basePrice: 3,
        variants: [
          {
            key: 'lemon-250ml',
            nameAr: 'كينزا ليمون 250 مل',
            nameEn: 'Kinza Lemon 250 ML',
            priceDelta: 0,
            isDefault: true,
          },
          {
            key: 'citrus-250ml',
            nameAr: 'كينزا حمضيات 250 مل',
            nameEn: 'Kinza Citrus 250 ML',
            priceDelta: 0,
            isDefault: false,
          },
          {
            key: 'orange-250ml',
            nameAr: 'كينزا برتقال 250 مل',
            nameEn: 'Kinza Orange 250 ML',
            priceDelta: 0,
            isDefault: false,
          },
          {
            key: 'cola-250ml',
            nameAr: 'كينزا كولا 250 مل',
            nameEn: 'Kinza Cola 250 ML',
            priceDelta: 0,
            isDefault: false,
          },
        ],
      },
    ],
  },
  {
    key: 'side-items',
    nameAr: 'الأطباق الجانبية',
    nameEn: 'Side Items',
    items: [
      {
        key: 'green-salad',
        nameAr: 'سلطة خضراء',
        nameEn: 'Green Salad',
        descriptionAr: 'سلطة خضراء مشكلة وطازجة.',
        descriptionEn: 'Fresh mixed green salad.',
        basePrice: 3,
        calories: 85,
        // Source showed both Kinza Citrus and Kinza Lemon; both resolve to
        // the same parent "kinza" MenuItem — stored once, not duplicated.
        recommendationKeys: ['kinza', 'tahinah'],
      },
      {
        key: 'bread',
        nameAr: 'خبز',
        nameEn: 'Bread',
        descriptionAr: 'خبز مصنوع من الدقيق الفاخر.',
        descriptionEn: 'Bread made from fine flour.',
        basePrice: 1,
        calories: 230,
      },
      {
        key: 'tahinah',
        nameAr: 'طحينة',
        nameEn: 'Tahinah',
        descriptionAr: 'طحينة سائلة مع الفلفل الأسود والملح والخل.',
        descriptionEn: 'Liquid tahinah with black pepper, salt, and vinegar.',
        basePrice: 2,
        calories: 89,
      },
    ],
  },
  {
    key: 'kids-meals',
    nameAr: 'وجبات الأطفال',
    nameEn: 'Kids Meals',
    items: [
      {
        key: 'kofta-kids-meal',
        nameAr: 'وجبة أطفال كفتة',
        nameEn: 'Kofta Kids Meal',
        descriptionAr: 'كفتة لحم محضرة بتوابل خاصة مع الطحينة ومخبوزة في الفرن.',
        descriptionEn: 'Meat kofta prepared with special spices and tahini in the oven.',
        basePrice: 20,
        calories: 340,
        recommendationKeys: ['mix-mokh-and-pane-liver-sandwich', 'tuhal-sandwich', 'kinza'],
      },
      {
        key: 'hawawshi-kids-meal',
        nameAr: 'وجبة أطفال حواوشي',
        nameEn: 'Hawawshi Kids Meal',
        descriptionAr: 'لحم مفروم متبل ومحشو داخل الخبز.',
        descriptionEn: 'Marinated minced meat stuffed in bread.',
        basePrice: 20,
        calories: 370,
        recommendationKeys: ['meat-hawawshi', 'sausage-hawawshi', 'kinza'],
      },
    ],
  },
  {
    key: 'hawawshi',
    nameAr: 'الحواوشي',
    nameEn: 'Hawawshi',
    items: [
      {
        key: 'meat-hawawshi',
        nameAr: 'حواوشي لحم',
        nameEn: 'Meat Hawawshi',
        descriptionAr: 'حواوشي لحم شهي محضر بطريقتنا الخاصة.',
        descriptionEn: 'Delicious beef hawawshi prepared in our own way.',
        basePrice: 13,
        calories: 297,
        badge: 'BESTSELLER',
        variants: [
          { key: 'small', nameAr: 'صغير', nameEn: 'Small', priceDelta: 0, isDefault: true },
          { key: 'large', nameAr: 'كبير', nameEn: 'Large', priceDelta: 7, isDefault: false },
        ],
        recommendationKeys: ['tuhal-sandwich', 'bread', 'seven-up'],
      },
      {
        key: 'sausage-hawawshi',
        nameAr: 'حواوشي سجق',
        nameEn: 'Sausage Hawawshi',
        descriptionAr: 'خبز مصري محشو بخليط سجق متبل.',
        descriptionEn: 'Egyptian bread stuffed with a seasoned sausage mixture.',
        basePrice: 13,
        calories: 350,
        variants: [
          { key: 'small', nameAr: 'صغير', nameEn: 'Small', priceDelta: 0, isDefault: true },
          { key: 'large', nameAr: 'كبير', nameEn: 'Large', priceDelta: 7, isDefault: false },
        ],
        recommendationKeys: ['kinza', 'pepsi', 'tuhal-sandwich'],
      },
      {
        key: 'kofta-hawawshi',
        nameAr: 'حواوشي كفتة',
        nameEn: 'Kofta Hawawshi',
        descriptionAr: 'شرائح خبز مشوية على الفحم ومحشوة باللحم المفروم.',
        descriptionEn: 'Charcoal-grilled bread slices stuffed with minced meat.',
        basePrice: 17,
        calories: 297,
        variants: [
          { key: 'small', nameAr: 'صغير', nameEn: 'Small', priceDelta: 0, isDefault: true },
          { key: 'large', nameAr: 'كبير', nameEn: 'Large', priceDelta: 8, isDefault: false },
        ],
        recommendationKeys: ['mix-mokh-and-pane-liver-sandwich', 'meat-hawawshi', 'tuhal-sandwich'],
      },
      {
        key: 'meat-hawawshi-with-cheese',
        nameAr: 'حواوشي لحم بالجبنة',
        nameEn: 'Meat Hawawshi With Cheese',
        descriptionAr: 'خبز محشو باللحم المفروم المتبل مع البصل والفلفل والبقدونس والجبنة.',
        descriptionEn:
          'Bread stuffed with seasoned minced meat, onions, peppers, parsley, and cheese.',
        basePrice: 15,
        calories: 330,
        variants: [
          { key: 'small', nameAr: 'صغير', nameEn: 'Small', priceDelta: 0, isDefault: true },
          { key: 'large', nameAr: 'كبير', nameEn: 'Large', priceDelta: 7, isDefault: false },
        ],
        // Source's third recommendation appeared to be a dessert item but
        // wasn't reliably identified in the approved core dataset — omitted,
        // not guessed.
        recommendationKeys: ['kinza', 'meat-hawawshi'],
      },
      {
        key: 'sausage-hawawshi-with-cheese',
        nameAr: 'حواوشي سجق بالجبنة',
        nameEn: 'Sausage Hawawshi With Cheese',
        descriptionAr: 'حواوشي سجق مصري مع جبنة شيدر.',
        descriptionEn: 'Egyptian sausage hawawshi with cheddar cheese.',
        basePrice: 15,
        calories: 350,
        variants: [
          { key: 'small', nameAr: 'صغير', nameEn: 'Small', priceDelta: 0, isDefault: true },
          { key: 'large', nameAr: 'كبير', nameEn: 'Large', priceDelta: 7, isDefault: false },
        ],
        recommendationKeys: ['tuhal-sandwich', 'tahinah', 'pane-liver-sandwich'],
      },
    ],
  },
  {
    key: 'egyptian-grills',
    nameAr: 'المشويات المصرية',
    nameEn: 'Egyptian Grills',
    items: [
      {
        key: 'lamb-chops-dish',
        nameAr: 'طبق ريش ضاني',
        nameEn: 'Lamb Chops Dish',
        descriptionAr: 'ست قطع من ريش الضأن تُقدم مع الخبز والسلطات.',
        descriptionEn: 'Six pieces of lamb chops served with bread and salads.',
        basePrice: 60,
        calories: 280,
        recommendationKeys: ['fishah-plate', 'pasta-with-ground-beef', 'green-salad'],
      },
      {
        key: 'mix-tiger',
        nameAr: 'ميكس تايجر',
        nameEn: 'Mix Tiger',
        descriptionAr: 'كبدة مشوية مع كباب وكفتة وشيش وطرب.',
        descriptionEn: 'Grilled liver with kebab, kofta, shish, and tarb.',
        basePrice: 65,
        calories: 900,
        // Source's third recommendation was Rice Pudding, not in the
        // approved core dataset — omitted, not created.
        recommendationKeys: ['mix-pane-and-askindirani-liver-plate', 'water'],
      },
      {
        key: 'mix-zaman',
        nameAr: 'ميكس زمان',
        nameEn: 'Mix Zaman',
        descriptionAr: 'كباب مع كفتة وشيش وطرب.',
        descriptionEn: 'Kebab with kofta, shish, and tarb.',
        basePrice: 52,
        calories: 715,
        recommendationKeys: ['hawawshi-kids-meal', 'rice', 'meat-hawawshi-with-cheese'],
      },
      {
        key: 'mix-mukhsos',
        nameAr: 'ميكس مخصوص',
        nameEn: 'Mix Mukhsos',
        descriptionAr: 'كبدة مشوية مع شيش وكباب وكفتة.',
        descriptionEn: 'Grilled liver with shish, kebab, and kofta.',
        basePrice: 50,
        calories: 630,
        recommendationKeys: ['pane-liver-sandwich', 'rice', 'meat-hawawshi'],
      },
      {
        key: 'tarb-plate',
        nameAr: 'طبق طرب',
        nameEn: 'Tarb Plate',
        descriptionAr: 'لحم مفروم محشو بطبقة خفيفة من الدهن ومتبل بالملح والتوابل.',
        descriptionEn:
          'Minced meat wrapped in a light layer of fat and seasoned with salt and spices.',
        basePrice: 52,
        calories: 951,
        recommendationKeys: ['mix-chef-plate', 'kofta-plate', 'tahinah'],
      },
      {
        key: 'awsal-kebab-plate',
        nameAr: 'طبق أوصال كباب',
        nameEn: 'Awsal Kebab Plate',
        descriptionAr: 'قطع لحم متبلة ومشوية مع خضروات طازجة.',
        descriptionEn: 'Marinated and grilled meat pieces with fresh vegetables.',
        basePrice: 45,
        calories: 1080,
        recommendationKeys: ['pane-liver-sandwich', 'meat-hawawshi', 'plain-pasta'],
      },
      {
        key: 'grilled-liver-plate',
        nameAr: 'طبق كبدة مشوية',
        nameEn: 'Grilled Liver Plate',
        descriptionAr: 'كبدة مشوية ومطهوة مع خضروات طازجة.',
        descriptionEn: 'Grilled liver cooked with fresh vegetables.',
        basePrice: 42,
        calories: 360,
        // Source's third recommendation was Custard, not in the approved
        // core dataset — omitted, not created.
        recommendationKeys: ['fishah-sandwich', 'kofta-hawawshi'],
      },
      {
        key: 'shish-tawouk-plate',
        nameAr: 'طبق شيش طاووق',
        nameEn: 'Shish Tawouk Plate',
        descriptionAr: 'قطع دجاج متبلة ومشوية بطريقتنا الخاصة.',
        descriptionEn: 'Marinated and grilled chicken pieces prepared in our own way.',
        basePrice: 42,
        calories: 381,
        recommendationKeys: ['askindirani-liver-plate', 'kofta-kids-meal', 'kinza'],
      },
      {
        key: 'kofta-plate',
        nameAr: 'طبق كفتة',
        nameEn: 'Kofta Plate',
        descriptionAr: 'لحم مفروم متبل بالتوابل والبصل والملح.',
        descriptionEn: 'Minced meat seasoned with spices, onions, and salt.',
        basePrice: 45,
        calories: 822,
        recommendationKeys: ['fishah-and-tuhal-plate', 'mix-zaman', 'mix-mukhsos'],
      },
      {
        key: 'tarb-sandwich',
        nameAr: 'ساندويتش طرب',
        nameEn: 'Tarb Sandwich',
        descriptionAr: 'طرب مصري بتتبيلة خاصة داخل خبز طازج.',
        descriptionEn: 'Egyptian tarb with special seasoning, served in fresh bread.',
        basePrice: 20,
        calories: 317,
        badge: 'TOP_RATED',
        // Source's third recommendation was Rice Pudding, not in the
        // approved core dataset — omitted, not created.
        recommendationKeys: ['sausage-hawawshi', 'mix-mokh-and-pane-liver-sandwich'],
      },
    ],
  },
  {
    key: 'sandwiches-and-plates',
    nameAr: 'الساندويتشات والأطباق',
    nameEn: 'Sandwiches And Plates',
    items: [
      {
        key: 'awsal-kebab-sandwich',
        nameAr: 'ساندويتش أوصال كباب',
        nameEn: 'Awsal Kebab Sandwich',
        descriptionAr: 'ساندويتش قطع لحم متبلة ومشوية مع خضروات طازجة.',
        descriptionEn: 'Marinated and grilled meat pieces with fresh vegetables in bread.',
        basePrice: 17,
        calories: 360,
        // Source's third recommendation was Rice Pudding, not in the
        // approved core dataset — omitted, not created.
        recommendationKeys: ['askindirani-liver-sandwich', 'bread'],
      },
      {
        key: 'grilled-liver-sandwich',
        nameAr: 'ساندويتش كبدة مشوية',
        nameEn: 'Grilled Liver Sandwich',
        descriptionAr: 'كبدة متبلة ومشوية على الطريقة المصرية داخل خبز طازج.',
        descriptionEn: 'Egyptian-style grilled marinated liver served in fresh bread.',
        basePrice: 16,
        calories: 121,
        recommendationKeys: [
          'awsal-kebab-sandwich',
          'fishah-sandwich',
          'mix-pane-and-askindirani-liver-sandwich',
        ],
      },
      {
        key: 'shish-tawouk-sandwich',
        nameAr: 'ساندويتش شيش طاووق',
        nameEn: 'Shish Tawouk Sandwich',
        descriptionAr: 'قطع دجاج مشوية داخل خبز طازج.',
        descriptionEn: 'Grilled chicken pieces served in fresh bread.',
        basePrice: 16,
        calories: 127,
        recommendationKeys: ['rice', 'seven-up', 'grilled-liver-sandwich'],
      },
      {
        key: 'kofta-sandwich',
        nameAr: 'ساندويتش كفتة',
        nameEn: 'Kofta Sandwich',
        descriptionAr: 'كفتة مصرية مفرومة ومتـبلة بالتوابل والبصل والملح.',
        descriptionEn: 'Egyptian minced kofta seasoned with spices, onions, and salt.',
        basePrice: 17,
        calories: 274,
        badge: 'TOP_RATED',
        recommendationKeys: [
          'kofta-kids-meal',
          'mix-mokh-and-pane-liver-sandwich',
          'tarb-sandwich',
        ],
      },
      {
        key: 'mix-jumbo-plate',
        nameAr: 'طبق ميكس جامبو',
        nameEn: 'Mix Jumbo Plate',
        descriptionAr: 'مخ مع كبدة بانيه وكبدة إسكندراني وفشة وطحال.',
        descriptionEn: 'Mokh with pane liver, Alexandrian liver, fishah, and tuhal.',
        basePrice: 70,
        calories: 880,
        recommendationKeys: ['kofta-kids-meal', 'kinza', 'hawawshi-kids-meal'],
      },
      {
        key: 'mix-combo-plate',
        nameAr: 'طبق ميكس كومبو',
        nameEn: 'Mix Combo Plate',
        descriptionAr: 'مخ مع كبدة بانيه واثنين سيخ مشويات.',
        descriptionEn: 'Mokh with pane liver and two grilled skewers.',
        basePrice: 65,
        calories: 770,
        recommendationKeys: ['green-salad', 'fishah-and-tuhal-plate', 'meat-hawawshi'],
      },
      {
        key: 'mix-plate-with-mokh',
        nameAr: 'طبق ميكس بالمخ',
        nameEn: 'Mix Plate With Mokh',
        descriptionAr: 'طبق مشكل من المخ والكبدة البانيه.',
        descriptionEn: 'A mixed plate of mokh and pane liver.',
        basePrice: 60,
        calories: 478,
        recommendationKeys: ['fishah-and-tuhal-sandwich', 'sausage-hawawshi', 'mix-zaman'],
      },
      {
        key: 'mix-mokh-and-pane-liver-plate',
        nameAr: 'طبق ميكس مخ وكبدة بانيه',
        nameEn: 'Mix Mokh And Pane Liver Plate',
        descriptionAr: 'مزيج من المخ والكبدة البانيه.',
        descriptionEn: 'A mix of mokh and pane liver.',
        basePrice: 60,
        calories: 400,
        recommendationKeys: [
          'kinza',
          'mix-pane-and-askindirani-liver-sandwich',
          'mix-fishah-tuhal-askindirani-plate',
        ],
      },
      {
        key: 'mokh-plate',
        nameAr: 'طبق مخ',
        nameEn: 'Mokh Plate',
        descriptionAr: 'مخ محضر بطريقة خاصة مع توابل شهية.',
        descriptionEn: 'Mokh prepared in a special way with delicious spices.',
        basePrice: 60,
        calories: 105,
        // Source's third recommendation was Custard, not in the approved
        // core dataset — omitted, not created.
        recommendationKeys: ['mix-mukhsos', 'askindirani-liver-plate'],
      },
      {
        key: 'sheep-head-meat-plate',
        nameAr: 'طبق لحمة رأس',
        nameEn: 'Meat From The Sheep Head Plate',
        descriptionAr: 'طبق من لحم الرأس المطهو والمتبل.',
        descriptionEn: 'Seasoned and cooked sheep-head meat.',
        basePrice: 50,
        calories: 864,
        recommendationKeys: [
          'mix-pane-and-askindirani-liver-sandwich',
          'mix-plate-without-mokh',
          'tuhal-plate',
        ],
      },
      {
        key: 'mix-chef-plate',
        nameAr: 'طبق ميكس شيف',
        nameEn: 'Mix Chef Plate',
        descriptionAr: 'كبدة بانيه مع كبدة إسكندراني واثنين سيخ مشويات.',
        descriptionEn: 'Pane liver with Alexandrian liver and two grilled skewers.',
        basePrice: 50,
        calories: 630,
        recommendationKeys: ['mix-fishah-tuhal-askindirani-plate', 'shish-tawouk-plate', 'kinza'],
      },
      {
        key: 'mix-plate-without-mokh',
        nameAr: 'طبق ميكس بدون مخ',
        nameEn: 'Mix Plate Without Mokh',
        descriptionAr: 'سجق وكبدة إسكندراني وكبدة بانيه.',
        descriptionEn: 'Sausage, Alexandrian liver, and pane liver.',
        basePrice: 42,
        calories: 225,
        recommendationKeys: ['askindirani-liver-plate', 'rice', 'kofta-sandwich'],
      },
      {
        key: 'sausage-plate',
        nameAr: 'طبق سجق',
        nameEn: 'Sausage Plate',
        descriptionAr: 'طبق سجق مطهو ومتبل.',
        descriptionEn: 'Cooked and seasoned sausage.',
        basePrice: 40,
        calories: 830,
        // Source's third recommendation was Rice Pudding, not in the
        // approved core dataset — omitted, not created.
        recommendationKeys: ['sausage-hawawshi', 'mix-mokh-and-pane-liver-sandwich'],
      },
      {
        key: 'tuhal-plate',
        nameAr: 'طبق طحال',
        nameEn: 'Tuhal Plate',
        descriptionAr: 'طحال متبل ومشوي.',
        descriptionEn: 'Marinated and grilled tuhal.',
        basePrice: 38,
        calories: 395,
        recommendationKeys: ['water', 'bread', 'awsal-kebab-sandwich'],
      },
      {
        key: 'mix-pane-and-askindirani-liver-plate',
        nameAr: 'طبق ميكس كبدة بانيه وإسكندراني',
        nameEn: 'Mix Pane And Askindirani Liver Plate',
        descriptionAr: 'كبدة بانيه مع كبدة إسكندراني.',
        descriptionEn: 'Pane liver with Alexandrian liver.',
        basePrice: 32,
        calories: 400,
        recommendationKeys: ['sausage-hawawshi-with-cheese', 'fishah-plate', 'meat-hawawshi'],
      },
      {
        key: 'pane-liver-plate',
        nameAr: 'طبق كبدة بانيه',
        nameEn: 'Pane Liver Plate',
        descriptionAr: 'كبدة بانيه متبلة ومقرمشة.',
        descriptionEn: 'Seasoned crispy pane liver.',
        basePrice: 36,
        calories: 410,
        recommendationKeys: [
          'mix-mokh-and-pane-liver-sandwich',
          'pepsi',
          'sausage-hawawshi-with-cheese',
        ],
      },
      {
        key: 'mix-fishah-tuhal-askindirani-plate',
        nameAr: 'طبق ميكس فشة وطحال وكبدة إسكندراني',
        nameEn: 'Mix Fishah With Tuhal And Askindirani Plate',
        descriptionAr: 'طبق مشكل من الفشة والطحال والكبدة الإسكندراني.',
        descriptionEn: 'A mixed plate of fishah, tuhal, and Alexandrian liver.',
        basePrice: 32,
        calories: 400,
        // Source's third recommendation was Custard, not in the approved
        // core dataset — omitted, not created.
        recommendationKeys: ['water', 'tahinah'],
      },
      {
        key: 'fishah-and-tuhal-plate',
        nameAr: 'طبق فشة وطحال',
        nameEn: 'Fishah And Tuhal Plate',
        descriptionAr: 'فشة وطحال مطهوان بالطريقة التقليدية.',
        descriptionEn: 'Fishah and tuhal cooked in the traditional way.',
        basePrice: 30,
        calories: 250,
        recommendationKeys: [
          'mix-pane-and-askindirani-liver-plate',
          'meat-hawawshi',
          'hawawshi-kids-meal',
        ],
      },
      {
        key: 'fishah-plate',
        nameAr: 'طبق فشة',
        nameEn: 'Fishah Plate',
        descriptionAr: 'فشة بقري متبلة ومطهية بطريقتنا الخاصة.',
        descriptionEn: 'Marinated beef fishah cooked in our own way.',
        basePrice: 28,
        calories: 238,
        recommendationKeys: [
          'kofta-hawawshi',
          'mix-pane-and-askindirani-liver-plate',
          'sausage-hawawshi',
        ],
      },
      {
        key: 'askindirani-liver-plate',
        nameAr: 'طبق كبدة إسكندراني',
        nameEn: 'Askindirani Liver Plate',
        descriptionAr: 'كبدة إسكندراني متبلة ومطهية على الطريقة المصرية.',
        descriptionEn: 'Egyptian-style Alexandrian liver.',
        basePrice: 30,
        calories: 410,
        recommendationKeys: ['sausage-pasta', 'pane-liver-sandwich', 'kofta-hawawshi'],
      },
      {
        key: 'mix-mokh-and-pane-liver-sandwich',
        nameAr: 'ساندويتش ميكس مخ وكبدة بانيه',
        nameEn: 'Mix Mokh And Pane Liver Sandwich',
        descriptionAr: 'مخ مع كبدة بانيه داخل خبز طازج.',
        descriptionEn: 'Mokh with pane liver served in fresh bread.',
        basePrice: 20,
        calories: 160,
        recommendationKeys: ['pane-liver-sandwich', 'sausage-sandwich', 'sausage-hawawshi'],
      },
      {
        key: 'mokh-sandwich',
        nameAr: 'ساندويتش مخ',
        nameEn: 'Mokh Sandwich',
        descriptionAr: 'ساندويتش مخ شهي محضر بطريقة خاصة.',
        descriptionEn: 'Delicious mokh sandwich prepared in a special way.',
        basePrice: 20,
        calories: 412,
        badge: 'BESTSELLER',
        // Source's third recommendation was Custard, not in the approved
        // core dataset — omitted, not created.
        recommendationKeys: ['fishah-sandwich', 'plain-pasta'],
      },
      {
        key: 'sausage-sandwich',
        nameAr: 'ساندويتش سجق',
        nameEn: 'Sausage Sandwich',
        descriptionAr: 'ساندويتش سجق متبل مع صوص شهي.',
        descriptionEn: 'Seasoned sausage sandwich with a delicious sauce.',
        basePrice: 17,
        calories: 332,
        recommendationKeys: ['meat-hawawshi', 'kofta-hawawshi', 'water'],
      },
      {
        key: 'mix-pane-and-askindirani-liver-sandwich',
        nameAr: 'ساندويتش ميكس كبدة بانيه وإسكندراني',
        nameEn: 'Mix Pane And Askindirani Liver Sandwich',
        descriptionAr: 'كبدة بانيه وإسكندراني مطهية مع خضروات طازجة داخل الخبز.',
        descriptionEn:
          'Pane and Alexandrian liver cooked with fresh vegetables and served in bread.',
        basePrice: 16,
        calories: 160,
        // Source's third recommendation was Custard, not in the approved
        // core dataset — omitted, not created.
        recommendationKeys: ['water', 'sausage-hawawshi-with-cheese'],
      },
      {
        key: 'tuhal-sandwich',
        nameAr: 'ساندويتش طحال',
        nameEn: 'Tuhal Sandwich',
        descriptionAr: 'طحال متبل داخل خبز طازج.',
        descriptionEn: 'Seasoned tuhal served in fresh bread.',
        basePrice: 14,
        calories: 158,
        recommendationKeys: ['sausage-hawawshi-with-cheese', 'pepsi', 'tahinah'],
      },
      {
        key: 'fishah-and-tuhal-sandwich',
        nameAr: 'ساندويتش فشة وطحال',
        nameEn: 'Fishah And Tuhal Sandwich',
        descriptionAr: 'فشة وطحال مطهوان مع خضروات طازجة داخل الخبز.',
        descriptionEn: 'Fishah and tuhal cooked with fresh vegetables and served in bread.',
        basePrice: 13,
        calories: 100,
        // Source's third recommendation was Rice Pudding, not in the
        // approved core dataset — omitted, not created.
        recommendationKeys: ['water', 'kinza'],
      },
      {
        key: 'askindirani-liver-sandwich',
        nameAr: 'ساندويتش كبدة إسكندراني',
        nameEn: 'Askindirani Liver Sandwich',
        descriptionAr: 'كبدة إسكندراني مشوحة على الصاج بالطريقة المصرية.',
        descriptionEn: 'Egyptian-style Alexandrian liver sautéed on a griddle.',
        basePrice: 12,
        calories: 164,
        badge: 'TOP_RATED',
        recommendationKeys: ['tahinah', 'kinza', 'green-salad'],
      },
      {
        key: 'fishah-sandwich',
        nameAr: 'ساندويتش فشة',
        nameEn: 'Fishah Sandwich',
        descriptionAr: 'فشة مطهوة مع خضروات طازجة داخل الخبز.',
        descriptionEn: 'Cooked fishah with fresh vegetables served in bread.',
        basePrice: 12,
        calories: 95,
        recommendationKeys: ['orange-mirinda', 'water', 'tuhal-sandwich'],
      },
      {
        key: 'pane-liver-sandwich',
        nameAr: 'ساندويتش كبدة بانيه',
        nameEn: 'Pane Liver Sandwich',
        descriptionAr: 'كبدة بانيه متبلة ومقرمشة داخل خبز طازج.',
        descriptionEn: 'Seasoned crispy pane liver served in fresh bread.',
        basePrice: 13,
        calories: 165,
        badge: 'BESTSELLER',
        recommendationKeys: ['meat-hawawshi-with-cheese', 'water', 'meat-hawawshi'],
      },
    ],
  },
  {
    key: 'saving-boxes',
    nameAr: 'بوكسات التوفير',
    nameEn: 'Saving Boxes',
    items: [
      {
        key: 'happiness-box',
        nameAr: 'بوكس السعادة',
        nameEn: 'Happiness Box',
        descriptionAr: 'بوكس عائلي يضم ستة ساندويتشات متنوعة لتجربة متكاملة بسعر مناسب.',
        descriptionEn: 'A family box containing six assorted sandwiches at a reasonable price.',
        basePrice: 75,
        calories: 450,
        recommendationKeys: ['mokh-plate', 'liver-pasta', 'mix-plate-without-mokh'],
      },
      {
        key: 'double-box',
        nameAr: 'دبل بوكس',
        nameEn: 'Double Box',
        descriptionAr:
          'بوكس يكفي شخصين ويضم أربعة ساندويتشات، وكبدة إسكندراني، وسجق، وسلطات، وعبوتين كينزا، وعبوتين مياه.',
        descriptionEn:
          'A box for two with four sandwiches, Alexandrian liver, sausage, salads, two Kinza cans, and two waters.',
        basePrice: 50,
        calories: 230,
        recommendationKeys: ['sausage-hawawshi-with-cheese', 'water', 'seven-up'],
      },
      {
        key: 'akil-box',
        nameAr: 'بوكس أكيل',
        nameEn: 'Akil Box',
        descriptionAr:
          'وجبة عائلية تضم ساندويتشات سجق وكبدة إسكندراني وكفتة وشيش طاووق، مع السلطات والبطاطس والمياه والمشروبات.',
        descriptionEn:
          'A family box with sausage, Alexandrian liver, kofta, and shish tawouk sandwiches, served with salads, potatoes, water, and soft drinks.',
        basePrice: 105,
        calories: 750,
        recommendationKeys: ['sausage-hawawshi-with-cheese', 'sausage-hawawshi', 'mix-zaman'],
      },
      {
        key: 'hawawshi-box',
        nameAr: 'بوكس حواوشي',
        nameEn: 'Hawawshi Box',
        descriptionAr: 'بوكس يضم سبعة أرغفة حواوشي كبيرة محضرة بمكونات طازجة.',
        descriptionEn:
          'A box containing seven large hawawshi loaves prepared with fresh ingredients.',
        basePrice: 125,
        calories: 450,
        recommendationKeys: ['mix-plate-without-mokh', 'kilo-kofta', 'shish-tawouk-sandwich'],
      },
    ],
  },
  {
    key: 'macaroni-and-rice',
    nameAr: 'المكرونة والأرز',
    nameEn: 'Macaroni And Rice',
    items: [
      {
        key: 'sausage-pasta',
        nameAr: 'مكرونة بالسجق',
        nameEn: 'Sausage Pasta',
        descriptionAr: 'مكرونة شهية مطهية مع قطع السجق.',
        descriptionEn: 'Delicious pasta cooked with sausage pieces.',
        basePrice: 25,
        calories: 600,
        recommendationKeys: ['pane-liver-sandwich', 'green-salad', 'kinza'],
      },
      {
        key: 'liver-pasta',
        nameAr: 'مكرونة بالكبدة',
        nameEn: 'Liver Pasta',
        descriptionAr: 'مكرونة بالصلصة الحمراء مع كبدة محضرة بتوابل شهية.',
        descriptionEn: 'Pasta in red sauce with liver prepared with delicious spices.',
        basePrice: 25,
        calories: 580,
        // Source's third recommendation was Rice Pudding, not in the
        // approved core dataset — omitted, not created.
        recommendationKeys: ['kofta-kids-meal', 'sausage-pasta'],
      },
      {
        key: 'pasta-with-ground-beef',
        nameAr: 'مكرونة باللحم المفروم',
        nameEn: 'Pasta With Ground Beef',
        descriptionAr: 'مكرونة بالصلصة الحمراء مع اللحم المفروم والتوابل الخاصة.',
        descriptionEn: 'Pasta in red sauce with ground beef and special spices.',
        basePrice: 20,
        compareAtPrice: 25,
        calories: 500,
        recommendationKeys: ['fishah-sandwich', 'green-salad', 'awsal-kebab-sandwich'],
      },
      {
        key: 'plain-pasta',
        nameAr: 'مكرونة سادة',
        nameEn: 'Plain Pasta',
        descriptionAr: 'مكرونة شهية مطهية بصلصة خاصة.',
        descriptionEn: 'Delicious pasta cooked with a special sauce.',
        basePrice: 20,
        calories: 327,
        recommendationKeys: ['pepsi', 'sausage-hawawshi', 'grilled-liver-sandwich'],
      },
      {
        key: 'rice',
        nameAr: 'أرز',
        nameEn: 'Rice',
        descriptionAr: 'أرز أبيض مطهو.',
        descriptionEn: 'Cooked white rice.',
        basePrice: 10,
        calories: 292,
        recommendationKeys: ['pepsi', 'orange-mirinda', 'bread'],
      },
      {
        // Source screenshots showed two near-identical English labels
        // ("1 Kilo Mixs Grill" and "Kilo Mixs Grill") for the same product —
        // treated as one item, not duplicated.
        key: 'kilo-mixed-grill',
        nameAr: 'كيلو مشويات مشكلة',
        nameEn: 'Kilo Mixed Grill',
        descriptionAr: 'كيلو من تشكيلة المشويات.',
        descriptionEn: 'One kilogram of assorted mixed grill.',
        basePrice: 136,
        compareAtPrice: 170,
        calories: 2300,
        recommendationKeys: ['tarb-sandwich', 'grilled-liver-plate', 'lamb-chops-dish'],
      },
      {
        key: 'kilo-kofta',
        nameAr: 'كيلو كفتة',
        nameEn: '1 Kilo Kofta',
        descriptionAr: 'كيلو كفتة يُقدم مع السلطة والطحينة والخبز.',
        descriptionEn: 'One kilogram of kofta served with salad, tahinah, and bread.',
        basePrice: 120,
        compareAtPrice: 150,
        calories: 2740,
        recommendationKeys: ['grilled-liver-plate', 'fishah-and-tuhal-sandwich', 'mix-chef-plate'],
      },
    ],
  },
];
