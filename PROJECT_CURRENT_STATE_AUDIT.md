# PROJECT_CURRENT_STATE_AUDIT.md
## Kebda Zaman — Comprehensive Technical Audit & Single Source of Truth

**Audit Timestamp:** 2026-07-23T19:40:00+03:00  
**Project:** Kebda Zaman (كبدة زمان) Multi-Platform Ecosystem  
**Target File Path:** `c:\Users\user\OneDrive - Higher Technological Institute\Desktop\kebda zaman\kebda_zaman\PROJECT_CURRENT_STATE_AUDIT.md`

---

## 1. PROJECT OVERVIEW

The **Kebda Zaman** project is a food ordering and restaurant management platform consisting of a **Flutter Customer Mobile/Web Application** and an **Admin Panel Frontend**. This document serves as the absolute single source of truth prior to any backend construction, database schema generation, or frontend API integration.

### Ecosystem Status Matrix

| Component / Layer | Current Status | Details |
| :--- | :--- | :--- |
| **Flutter Customer App** | **Fully Implemented (UI & Local State)** | All 19 screens built, styled with `KZ` design tokens, multilingual (`easy_localization`), and responsive. |
| **Admin Panel Frontend** | **Fully Implemented (UI & Fake Repositories)** | All 10 management views (Dashboard, Menu, Orders, Offers, Push Notifications, Settings) built with responsive layout (`AdminShell`). |
| **Firebase Core & FCM** | **Fully Configured & Connected** | Registered under project `keebda-zaman`. Official `google-services.json` and `firebase_options.dart` present and initialized. |
| **Push Notification Infrastructure** | **Prepared & Functional Locally** | Local foreground banners (`flutter_local_notifications`), background handlers, and deep-link routing active. |
| **Backend API** | **NOT IMPLEMENTED** | No REST/GraphQL API server exists yet. All data is served from local fake repositories. |
| **Database** | **NOT IMPLEMENTED** | No database server (PostgreSQL/MongoDB/MySQL) or ORM (Prisma/TypeORM) exists yet. |
| **Authentication** | **Mocked / Local Persistence** | Local `SharedPreferences` session storage via `AuthNotifier`. No remote JWT issuance or OAuth. |

### Component Status Classification

- **Fully Implemented (UI/UX & Local State):**
  - Splash animation, Onboarding slider, Language selector, Auth choice hub.
  - Form validation for Login and Sign Up screens.
  - Home screen carousel, Category bar, Featured food list, Bottom navigation bar.
  - Menu listing, Sub-category tabs, Food item search, Item customization modal (variants, add-ons, quantity).
  - Cart item management, Promo code application, Order summary calculations.
  - Multi-step Checkout flow (Address selection, Delivery method, Payment method picker).
  - Live Order Tracking screen with step timeline indicator and map placeholder.
  - Order History list with status badges and re-order triggers.
  - Profile screen with dynamic user details and inline language toggle.
  - Admin Push Notification Campaign Composer, Live Smartphone Notification Preview, and Campaign History table.
  - Admin Menu, Orders, Offers, Categories, and Settings management screens.

- **Frontend-Only / Mocked:**
  - `FakeMenuRepository`: Hardcoded catalog of 6 categories and 10 detailed menu items with variants and add-ons.
  - `FakeOrderRepository`: In-memory list of orders with simulated status updates (`pending` -> `confirmed` -> `preparing` -> `outForDelivery` -> `delivered`).
  - `FakeCartRepository`: In-memory cart state.
  - `FakeAuthRepository` & `AuthNotifier`: Local login/signup/logout simulations storing user attributes in `SharedPreferences`.
  - `FakeLoyaltyRepository`: Mock points balance and rewards list.
  - `FakePromoRepository`: Hardcoded list of active promo codes (`KEBDA20`, `WELCOME50`, `SUMMER10`).
  - `FakeSettingsRepository`: Hardcoded store working hours, delivery fees, and tax rates.
  - `FakeAdminNotificationRepository`: Mock campaign history table entries.

- **Prepared for Future Backend Integration:**
  - `syncTokenWithBackend(String token)` method in `NotificationService` marked with `TODO: POST /devices/register`.
  - Abstract repository interfaces (`MenuRepository`, `OrderRepository`, `AuthRepository`, `CartRepository`, `LoyaltyRepository`, `PromoRepository`, `SettingsRepository`, `AdminNotificationRepository`).
  - `docs/future_backend_contract.md`: Comprehensive API specification document covering 10 backend integration requirements.

- **Not Implemented:**
  - Node.js / Express / NestJS / Python backend API server.
  - Database schema and migrations.
  - Server-side price calculation and validation.
  - Server-side payment gateway webhook handlers (Paymob / Fawry / Stripe).
  - Real-time WebSockets / Server-Sent Events for order tracking updates.

---

## 2. COMPLETE PROJECT STRUCTURE

```text
kebda_zaman/
├── android/                             # Android Native Configuration & Build Files
│   ├── app/
│   │   ├── google-services.json          # Official Firebase Android configuration file
│   │   ├── build.gradle.kts             # Module-level Gradle file (com.google.gms.google-services applied)
│   │   └── src/main/AndroidManifest.xml  # Permissions (POST_NOTIFICATIONS, INTERNET, VIBRATE) & meta-data
│   ├── build.gradle.kts                 # Project-level Gradle build configuration
│   └── settings.gradle.kts              # Plugin management (Google Services 4.4.2 declared)
├── assets/                              # Static Application Assets
│   ├── icons/                           # App branding logos and vector icons
│   ├── images/                          # Restaurant banners, fallback food images, emblems
│   └── translations/
│       ├── ar.json                      # Arabic translation dictionary (100% complete)
│       └── en.json                      # English translation dictionary (100% complete)
├── docs/
│   └── future_backend_contract.md       # Technical API contract for future backend developers
├── lib/
│   ├── app.dart                         # MaterialApp.router configuration, easy_localization, theme binding
│   ├── bootstrap.dart                   # Global app initialization wrapper
│   ├── firebase_options.dart            # Officially generated FirebaseOptions for Android, Web, iOS, macOS, Windows
│   ├── main.dart                        # Application entry point, NotificationService initialization
│   ├── core/                            # Shared Cross-Cutting Infrastructure
│   │   ├── di/
│   │   │   └── providers.dart           # Global Riverpod DI container mapping abstractions to Fake implementations
│   │   ├── errors/
│   │   │   └── errors.dart              # Standardized Failure and Result classes for clean error handling
│   │   ├── notifications/
│   │   │   ├── notification_model.dart  # AppNotificationPayload parser & NotificationType enum (14 types)
│   │   │   ├── notification_navigation_service.dart # GoRouter deep-link navigator for push taps
│   │   │   ├── notification_permission_service.dart # SharedPreferences-backed permission checker
│   │   │   └── notification_service.dart # Centralized FCM & flutter_local_notifications manager
│   │   ├── router/
│   │   │   └── router.dart              # GoRouter definitions for 19 customer routes & 10 admin routes
│   │   └── theme/
│   │       ├── colors.dart              # Brand color tokens (Kebda Red, Warm Amber, Dark Charcoal)
│   │       └── kz_design_system.dart    # KZ Design System components (buttons, text fields, cards, toggles)
│   ├── features/                        # Domain Feature Modules
│   │   ├── admin/                       # Admin Panel Management Module
│   │   │   ├── data/
│   │   │   │   └── fake_admin_notification_repository.dart # Mock campaign repository
│   │   │   ├── domain/
│   │   │   │   ├── models/
│   │   │   │   │   └── notification_campaign.dart # Campaign model & status enum
│   │   │   │   └── repositories/
│   │   │   │       └── admin_notification_repository.dart # Abstract campaign contract
│   │   │   └── presentation/
│   │   │       ├── screens/             # Admin Management Screens
│   │   │       │   ├── admin_category_form_screen.dart # Category Create/Edit form
│   │   │       │   ├── admin_food_form_screen.dart     # Food Item Create/Edit form
│   │   │       │   ├── admin_modifier_dialogs.dart     # Add-on group & Variant editor dialogs
│   │   │       │   ├── admin_notifications_screen.dart # Campaign Composer & Live Mobile Preview
│   │   │       │   ├── admin_promo_form_screen.dart    # Promo Code Create/Edit form
│   │   │       │   ├── admin_settings_screen.dart     # Restaurant operating config form
│   │   │       │   ├── dashboard_screen.dart           # Analytics charts & quick status cards
│   │   │       │   ├── menu_management_screen.dart     # Menu items data table with search/filters
│   │   │       │   ├── offers_screen.dart              # Active promos list & delete actions
│   │   │       │   └── order_management_screen.dart    # Live orders board with status chips
│   │   │       └── shells/
│   │   │           └── admin_shell.dart            # Desktop NavigationRail & Mobile BottomNav shell
│   │   ├── customer/                    # Customer App Module
│   │   │   └── presentation/
│   │   │       ├── notifiers/           # Riverpod State Notifiers
│   │   │       │   ├── auth_notifier.dart          # Local user session & SharedPreferences auth state
│   │   │       │   ├── cart_notifier.dart          # Local cart operations, totals & promo logic
│   │   │       │   └── orders_notifier.dart        # Local active & historical order state
│   │   │       └── screens/             # Customer Screens
│   │   │           ├── auth_choice_screen.dart     # Auth Hub (Sign In / Register / Guest)
│   │   │           ├── cart_screen.dart            # Shopping cart & checkout trigger
│   │   │           ├── checkout_screen.dart        # Multi-step checkout & payment selection
│   │   │           ├── favorites_screen.dart       # Saved favorite food items list
│   │   │           ├── home_screen.dart            # Customer home, banners, category pill bar
│   │   │           ├── item_details_screen.dart    # Full-page food customization screen
│   │   │           ├── language_select_screen.dart # Initial locale choice screen
│   │   │           ├── login_screen.dart           # Customer login form with validation
│   │   │           ├── loyalty_screen.dart         # Rewards points balance & redeem vouchers
│   │   │           ├── menu_screen.dart            # Full categorized food menu
│   │   │           ├── onboarding_screen.dart      # 3-slide interactive feature overview
│   │   │           ├── order_success_screen.dart   # Post-order confirmation & receipt summary
│   │   │           ├── order_tracking_screen.dart  # Real-time order progress timeline
│   │   │           ├── orders_screen.dart          # Order history & active orders tab view
│   │   │           ├── profile_screen.dart         # User account info, addresses & inline language toggle
│   │   │           ├── search_screen.dart          # Live food menu search & filtering
│   │   │           ├── settings_screen.dart        # Customer app settings view
│   │   │           ├── signup_screen.dart          # Customer registration form
│   │   │           └── splash_screen.dart          # Animated startup logo screen
│   │   └── shared/                      # Shared Cross-Feature Domain Models & Fake Repositories
│   │       ├── data/
│   │       │   ├── fake_auth_repository.dart       # Mock authentication repository
│   │       │   ├── fake_cart_repository.dart       # Mock cart repository
│   │       │   ├── fake_loyalty_repository.dart    # Mock rewards points repository
│   │       │   ├── fake_menu_repository.dart       # Mock food menu catalog repository
│   │       │   ├── fake_order_repository.dart      # Mock order placement & tracking repository
│   │       │   ├── fake_payment_service.dart       # Mock payment gateway process
│   │       │   ├── fake_promo_repository.dart      # Mock promo codes repository
│   │       │   └── fake_settings_repository.dart   # Mock restaurant settings repository
│   │       └── domain/
│   │           ├── models/              # Freezed & JSON Serializable Data Models
│   │           │   ├── address.dart, cart.dart, category.dart, loyalty.dart, menu_item.dart,
│   │           │   notification.dart, order.dart, payment.dart, promo_code.dart,
│   │           │   restaurant_settings.dart, user.dart
│   │           └── repositories/        # Abstract Repository Interfaces
│   │               ├── auth_repository.dart, cart_repository.dart, loyalty_repository.dart,
│   │               ├── menu_repository.dart, order_repository.dart, payment_service.dart,
│   │               └── promo_repository.dart, settings_repository.dart
│   └── generated/
│       └── codegen_loader.g.dart        # Pre-compiled easy_localization translation loader
├── pubspec.yaml                         # Flutter dependencies manifest
└── web/
    └── index.html                       # Web entry point
```

---

## 3. CUSTOMER APP — COMPLETE FEATURE INVENTORY

| Feature Screen | File Path | Implementation Status | Data Source | Models Used | Repositories / Notifiers | State Management | GoRouter Path | Backend Requirements |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Splash** | `splash_screen.dart` | Fully Implemented | `SharedPreferences` | None | None | StatefulWidget | `/splash` | None |
| **Language Select** | `language_select_screen.dart` | Fully Implemented | `easy_localization` | None | None | ConsumerStatefulWidget | `/language-select` | Persist user locale in user profile |
| **Onboarding** | `onboarding_screen.dart` | Fully Implemented | Local assets | None | None | StatefulWidget | `/onboarding` | Track onboarding completion state |
| **Auth Choice** | `auth_choice_screen.dart` | Fully Implemented | Local state | None | None | StatelessWidget | `/auth-choice` | None |
| **Login** | `login_screen.dart` | Fully Implemented | `SharedPreferences` | `User` | `AuthNotifier` | ConsumerStatefulWidget | `/login` | `POST /auth/login` (JWT return) |
| **Signup** | `signup_screen.dart` | Fully Implemented | `SharedPreferences` | `User` | `AuthNotifier` | ConsumerStatefulWidget | `/signup` | `POST /auth/signup` |
| **Home** | `home_screen.dart` | Fully Implemented | `FakeMenuRepository` | `MenuItem`, `Category`, `User` | `menuRepositoryProvider`, `AuthNotifier` | ConsumerStatefulWidget | `/home` | `GET /home/featured`, `GET /categories` |
| **Menu Catalog** | `menu_screen.dart` | Fully Implemented | `FakeMenuRepository` | `MenuItem`, `Category` | `menuRepositoryProvider` | ConsumerStatefulWidget | `/menu` | `GET /menu`, `GET /categories` |
| **Food Details / Customization** | `item_details_screen.dart` | Fully Implemented | `FakeMenuRepository` | `MenuItem`, `ItemVariant`, `Addon` | `cartNotifierProvider` | ConsumerStatefulWidget | `/item/:id` | `GET /menu/items/:id` |
| **Search** | `search_screen.dart` | Fully Implemented | `FakeMenuRepository` | `MenuItem` | `menuRepositoryProvider` | ConsumerStatefulWidget | `/search` | `GET /menu/search?q=` |
| **Favorites** | `favorites_screen.dart` | Fully Implemented | Local State | `MenuItem` | Local state | ConsumerStatefulWidget | `/favorites` | `GET /user/favorites`, `POST /user/favorites` |
| **Cart** | `cart_screen.dart` | Fully Implemented | `FakeCartRepository` | `Cart`, `CartItem`, `PromoCode` | `cartNotifierProvider` | ConsumerNotifier | `/cart` | `GET /cart`, `POST /cart/items`, `POST /cart/promo` |
| **Checkout** | `checkout_screen.dart` | Fully Implemented | `FakeOrderRepository` | `Order`, `Address`, `Payment` | `cartNotifierProvider`, `ordersNotifierProvider` | ConsumerStatefulWidget | `/checkout` | `POST /orders/checkout` (Server validation) |
| **Order Success** | `order_success_screen.dart` | Fully Implemented | `FakeOrderRepository` | `Order` | `ordersNotifierProvider` | ConsumerWidget | `/orders/confirmation/:id` | `GET /orders/:id` |
| **Order Tracking** | `order_tracking_screen.dart` | Fully Implemented | `FakeOrderRepository` | `Order` | `ordersNotifierProvider` | ConsumerStatefulWidget | `/orders/tracking/:id` | `GET /orders/:id/tracking` (WebSocket/SSE) |
| **Orders History** | `orders_screen.dart` | Fully Implemented | `FakeOrderRepository` | `Order` | `ordersNotifierProvider` | ConsumerWidget | `/orders` | `GET /user/orders` |
| **Profile & Settings** | `profile_screen.dart` | Fully Implemented | `SharedPreferences` | `User` | `AuthNotifier` | ConsumerStatefulWidget | `/profile` | `GET /user/profile`, `PUT /user/profile` |
| **Loyalty Rewards** | `loyalty_screen.dart` | Fully Implemented | `FakeLoyaltyRepository` | `LoyaltyAccount` | `loyaltyRepositoryProvider` | ConsumerWidget | `/loyalty` | `GET /user/loyalty` |
| **Offers & Promos** | `offers_screen.dart` | Fully Implemented | `FakePromoRepository` | `PromoCode` | `promoRepositoryProvider` | ConsumerWidget | `/offers` | `GET /promos/active` |

---

## 4. ADMIN PANEL — COMPLETE FEATURE INVENTORY

| Admin Screen | File Path | Implementation Status | Data Source / Repository | Features & Controls | Required Backend Endpoints |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Dashboard** | `dashboard_screen.dart` | Fully Implemented | `FakeOrderRepository`, `FakeMenuRepository` | Sales summary cards, active orders widget, top selling items list, revenue chart. | `GET /admin/dashboard/stats`, `GET /admin/dashboard/revenue` |
| **Menu Management** | `menu_management_screen.dart` | Fully Implemented | `FakeMenuRepository` | Searchable food items data table, category filter dropdown, item availability toggle switch, edit & delete actions. | `GET /admin/menu`, `PATCH /admin/menu/items/:id/availability` |
| **Food Item Editor Form** | `admin_food_form_screen.dart` | Fully Implemented | `FakeMenuRepository` | Form fields for Name (AR/EN), Description, Price, Image URL, Category, Item Variants editor, and Add-on Groups builder. | `POST /admin/menu/items`, `PUT /admin/menu/items/:id` |
| **Category Editor Form** | `admin_category_form_screen.dart` | Fully Implemented | `FakeMenuRepository` | Form fields for Category Name (AR/EN), Icon name/URL, and Display Order. | `POST /admin/categories`, `PUT /admin/categories/:id` |
| **Order Management** | `order_management_screen.dart` | Fully Implemented | `FakeOrderRepository` | Tabbed orders board (All, Pending, Confirmed, Preparing, Ready, Out for Delivery, Delivered, Cancelled). Instant status update dropdown. | `GET /admin/orders`, `PATCH /admin/orders/:id/status` |
| **Offers & Promos** | `offers_screen.dart` | Fully Implemented | `FakePromoRepository` | Data table of promo codes with discount percentage, minimum order amount, expiry date, and delete trigger. | `GET /admin/promos`, `DELETE /admin/promos/:id` |
| **Promo Form** | `admin_promo_form_screen.dart` | Fully Implemented | `FakePromoRepository` | Form fields for Code, Discount Type (% or Fixed), Value, Expiry Date, and Max Usage limit. | `POST /admin/promos`, `PUT /admin/promos/:id` |
| **Push Notifications** | `admin_notifications_screen.dart` | Fully Implemented | `FakeAdminNotificationRepository` | Notification Campaign Composer, Live Smartphone Notification Preview card, Audience filter with backend warning tags, Schedule picker, and Campaign History data table. | `POST /admin/notifications/send`, `POST /admin/notifications/schedule`, `GET /admin/notifications/campaigns` |
| **Restaurant Settings** | `admin_settings_screen.dart` | Fully Implemented | `FakeSettingsRepository` | Form for Restaurant Name, Phone, Address, Operating Hours, Tax %, Delivery Fee, Min Order Amount, and Maintenance Mode toggle. | `GET /admin/settings`, `PUT /admin/settings` |
| **Admin Shell Navigation** | `admin_shell.dart` | Fully Implemented | Local state & `go_router` | Responsive layout: Desktop `NavigationRail` with expandable labels & Mobile `BottomNavigationBar`. | None |

---

## 5. COMPLETE USER FLOWS

### Flow 1: First-Time Application Launch & Onboarding
```text
App Launch -> SplashScreen (2.4s Emblem Fade/Scale)
  -> Check SharedPreferences ('kz_lang_selected')
     ├─ False -> LanguageSelectScreen (/language-select) -> Save locale -> OnboardingScreen (/onboarding)
     └─ True -> Check SharedPreferences ('kz_onboarding_completed')
          ├─ False -> OnboardingScreen (/onboarding) -> 3 Slides -> AuthChoiceScreen (/auth-choice)
          └─ True -> HomeScreen (/home)
```

### Flow 2: Authentication & Guest Session
```text
AuthChoiceScreen (/auth-choice)
  ├─ Option A: "Sign In" -> LoginScreen (/login) -> Validate Form -> AuthNotifier.login() -> Save User to SharedPreferences -> HomeScreen (/home)
  ├─ Option B: "Create Account" -> SignupScreen (/signup) -> Validate Form -> AuthNotifier.signup() -> Save User -> HomeScreen (/home)
  └─ Option C: "Continue as Guest" -> AuthNotifier.continueAsGuest() -> Mark Guest state -> HomeScreen (/home)
```

### Flow 3: Product Discovery, Customization & Cart Addition
```text
HomeScreen (/home) OR MenuScreen (/menu)
  -> Tap Food Card -> Open ItemDetailsScreen (/item/:id)
  -> Select Size/Variant (e.g. "سندوتش كبير")
  -> Select Optional Add-ons (e.g. "طحينة زيادة", "فلفل حار")
  -> Adjust Quantity (+ / -)
  -> Real-Time Subtotal Calculation (Base Price + Variant Premium + Addons) * Quantity
  -> Tap "Add to Cart" -> CartNotifier.addItem() -> Show Floating SnackBar -> Navigate to CartScreen (/cart)
```

### Flow 4: Cart Management & Checkout Pipeline
```text
CartScreen (/cart)
  -> View Cart Items -> Adjust Quantities or Remove Items
  -> Enter Promo Code (e.g., 'KEBDA20') -> Validate via FakePromoRepository -> Apply Discount
  -> View Financial Breakdown: Subtotal + Delivery Fee + Tax - Promo Discount = Total Amount
  -> Tap "Proceed to Checkout" -> CheckoutScreen (/checkout)
  -> Step 1: Select Delivery Address (Home, Work, New Address)
  -> Step 2: Select Delivery Method (Standard Delivery, Pickup)
  -> Step 3: Select Payment Method (Cash on Delivery, Credit Card, Mobile Wallet)
  -> Tap "Place Order" -> FakeOrderRepository.createOrder() -> Clear Cart -> OrderSuccessScreen (/orders/confirmation/:id)
  -> Tap "Track Order" -> OrderTrackingScreen (/orders/tracking/:id)
```

### Flow 5: Push Notification Tap & Deep-Link Navigation
```text
Device receives FCM Push Notification (e.g., type: 'offer', route: '/item/item_001')
  ├─ App in Foreground -> Show Local Notification Banner (flutter_local_notifications) -> User Taps Banner
  ├─ App in Background -> User Taps System Notification
  └─ App in Terminated State -> User Taps System Notification -> App Boots -> NotificationService captures initialMessage
       ↓
NotificationNavigationService handles route '/item/item_001'
  -> Checks GoRouter readiness -> Executes context.go('/item/item_001') -> Opens item customization screen directly
```

---

## 6. DATA MODELS

### 6.1 `User` (`lib/features/shared/domain/models/user.dart`)
- **Fields:** `id` (String), `name` (String), `email` (String), `phone` (String?), `avatarUrl` (String?), `isGuest` (bool), `createdAt` (DateTime?).
- **Relationships:** Has many `Address` objects, Has many `Order` objects.
- **Current Status:** Saved locally in `SharedPreferences` as JSON. Ready for Backend API User Entity.

### 6.2 `MenuItem` (`lib/features/shared/domain/models/menu_item.dart`)
- **Fields:** `id` (String), `categoryId` (String), `nameAr` (String), `nameEn` (String), `descriptionAr` (String), `descriptionEn` (String), `basePrice` (double), `imageUrl` (String), `isAvailable` (bool), `isPopular` (bool), `variants` (List<ItemVariant>), `addonGroups` (List<AddonGroup>).
- **Relationships:** Belongs to `Category`, Has many `ItemVariant`, Has many `AddonGroup`.
- **Current Status:** Served via `FakeMenuRepository`. Fully structured for backend MongoDB/PostgreSQL schemas.

### 6.3 `ItemVariant` & `AddonGroup` / `Addon`
- **ItemVariant Fields:** `id` (String), `nameAr` (String), `nameEn` (String), `priceDelta` (double), `isDefault` (bool).
- **AddonGroup Fields:** `id` (String), `titleAr` (String), `titleEn` (String), `isRequired` (bool), `minSelect` (int), `maxSelect` (int), `addons` (List<Addon>).
- **Addon Fields:** `id` (String), `nameAr` (String), `nameEn` (String), `price` (double).

### 6.4 `Cart` & `CartItem` (`lib/features/shared/domain/models/cart.dart`)
- **Cart Fields:** `items` (List<CartItem>), `appliedPromo` (PromoCode?), `deliveryFee` (double), `taxRate` (double).
- **CartItem Fields:** `id` (String), `menuItem` (MenuItem), `selectedVariant` (ItemVariant?), `selectedAddons` (List<Addon>), `quantity` (int), `specialInstructions` (String?), `unitPrice` (double), `totalPrice` (double).

### 6.5 `Order` (`lib/features/shared/domain/models/order.dart`)
- **Fields:** `id` (String), `userId` (String), `user` (User?), `items` (List<OrderItem>), `status` (OrderStatus enum: `pending`, `confirmed`, `preparing`, `outForDelivery`, `delivered`, `cancelled`), `deliveryAddress` (Address), `paymentMethod` (String), `subtotal` (double), `deliveryFee` (double), `tax` (double), `discount` (double), `totalAmount` (double), `createdAt` (DateTime), `estimatedDeliveryTime` (DateTime?).

### 6.6 `NotificationCampaign` (`lib/features/admin/domain/models/notification_campaign.dart`)
- **Fields:** `id` (String), `campaignName` (String), `title` (String), `body` (String), `imageUrl` (String?), `type` (NotificationType enum), `targetAudience` (String), `destinationRoute` (String?), `entityId` (String?), `status` (CampaignStatus enum), `isScheduled` (bool), `scheduledAt` (DateTime?), `sentAt` (DateTime?), `totalRecipients` (int), `deliveredCount` (int), `openedCount` (int), `clickRate` (double).

### 6.7 `AppNotificationPayload` (`lib/core/notifications/notification_model.dart`)
- **Fields:** `id` (String), `type` (NotificationType enum), `title` (String), `body` (String), `route` (String?), `entityId` (String?), `imageUrl` (String?), `timestamp` (DateTime?).

---

## 7. MOCK DATA & HARDCODED DATA AUDIT

All fake repositories and mock datasets are localized strictly inside `lib/features/shared/data/` and `lib/features/admin/data/`.

| File Path | Data Content Summary | Dependent Screens | Future Backend Resource Replacement |
| :--- | :--- | :--- | :--- |
| `fake_menu_repository.dart` | 6 Categories (Kabsah, Kebda, Alexandrian, Extras, Drinks, Desserts) & 10 detailed food items with variants and add-on groups. | `HomeScreen`, `MenuScreen`, `ItemDetailsScreen`, `SearchScreen`, `AdminMenuManagementScreen`, `AdminFoodFormScreen`. | `GET /api/v1/categories`, `GET /api/v1/menu`, `POST /api/v1/admin/menu/items` |
| `fake_order_repository.dart` | Pre-populated order history list (`ord_1001`, `ord_1002`) with status tracking steps. | `OrdersScreen`, `OrderTrackingScreen`, `OrderSuccessScreen`, `AdminOrderManagementScreen`, `AdminDashboardScreen`. | `GET /api/v1/orders`, `POST /api/v1/orders`, `PATCH /api/v1/admin/orders/:id/status` |
| `fake_cart_repository.dart` | In-memory cart state storing active user cart items and calculating totals. | `CartScreen`, `CheckoutScreen`, `ItemDetailsScreen`. | `GET /api/v1/cart`, `POST /api/v1/cart/items`, `DELETE /api/v1/cart/items/:id` |
| `fake_auth_repository.dart` | Mock user credentials verification (`test@kebdazaman.com` / `123456`) and dummy user profile generation. | `LoginScreen`, `SignupScreen`, `ProfileScreen`, `AuthNotifier`. | `POST /api/v1/auth/login`, `POST /api/v1/auth/signup`, `GET /api/v1/user/profile` |
| `fake_loyalty_repository.dart` | Mock points balance (450 pts) and available reward vouchers (Free Kebda Sandwich, 50 EGP Off). | `LoyaltyScreen`. | `GET /api/v1/user/loyalty`, `POST /api/v1/user/loyalty/redeem` |
| `fake_promo_repository.dart` | Active promo codes (`KEBDA20` - 20% off, `WELCOME50` - 50 EGP off, `SUMMER10`). | `CartScreen`, `AdminOffersScreen`, `AdminPromoFormScreen`. | `GET /api/v1/promos/validate`, `GET /api/v1/admin/promos` |
| `fake_settings_repository.dart` | Restaurant config (Delivery fee: 20 EGP, Tax: 14%, Min Order: 50 EGP, Working hours: 10:00 - 02:00). | `CheckoutScreen`, `CartScreen`, `AdminSettingsScreen`. | `GET /api/v1/settings`, `PUT /api/v1/admin/settings` |
| `fake_admin_notification_repository.dart` | Mock campaign history table entries (`Weekend Kebda Special Deal`, `New Menu Launch`). | `AdminNotificationsScreen`. | `GET /api/v1/admin/notifications/campaigns`, `POST /api/v1/admin/notifications/send` |

---

## 8. SERVICES & REPOSITORIES

### 8.1 Di Provider Registry (`lib/core/di/providers.dart`)
Injects repository implementations using Riverpod `Provider`:
- `menuRepositoryProvider` -> `FakeMenuRepository`
- `authRepositoryProvider` -> `FakeAuthRepository`
- `paymentServiceProvider` -> `FakePaymentService`
- `cartRepositoryProvider` -> `FakeCartRepository`
- `orderRepositoryProvider` -> `FakeOrderRepository`
- `loyaltyRepositoryProvider` -> `FakeLoyaltyRepository`
- `promoRepositoryProvider` -> `FakePromoRepository`
- `settingsRepositoryProvider` -> `FakeSettingsRepository`
- `adminNotificationRepositoryProvider` -> `FakeAdminNotificationRepository`

### 8.2 Push Notification Infrastructure (`lib/core/notifications/`)
- `NotificationService`: Manages FCM lifecycle, background message entry point, local notification channel initialization, and FCM token retrieval.
- `NotificationPermissionService`: Manages system notification permission prompt status with `SharedPreferences` caching.
- `NotificationNavigationService`: Binds GoRouter instance to automatically handle deep-link navigation when a user taps a push notification.

---

## 9. STATE MANAGEMENT

### Flutter Customer App State Management (Riverpod)
- **`AuthNotifier` (`lib/features/customer/presentation/notifiers/auth_notifier.dart`):**
  - Manages `UserState` (`initial`, `authenticated`, `guest`, `unauthenticated`).
  - Persists user name, email, and login status across app restarts in `SharedPreferences`.
- **`CartNotifier` (`lib/features/customer/presentation/notifiers/cart_notifier.dart`):**
  - Manages `Cart` state (`items`, `appliedPromo`, `subtotal`, `deliveryFee`, `tax`, `total`).
  - Handles item quantity increments, item removals, item customizations, and promo code applications.
- **`OrdersNotifier` (`lib/features/customer/presentation/notifiers/orders_notifier.dart`):**
  - Manages `List<Order>` state for active and historical orders.
  - Triggers new order placement and updates status steps.

### Admin Panel State Management
- Utilizes `FutureProvider` and `ConsumerStatefulWidget` bound directly to `adminNotificationRepositoryProvider`, `menuRepositoryProvider`, `orderRepositoryProvider`, and `promoRepositoryProvider`.

---

## 10. ROUTING & NAVIGATION

Centralized in `lib/core/router/router.dart` using **GoRouter 14.x**:

### Customer App Routes (19 Routes)
- `/splash` -> `SplashScreen`
- `/language-select` -> `LanguageSelectScreen`
- `/onboarding` -> `OnboardingScreen`
- `/auth-choice` -> `AuthChoiceScreen`
- `/login` -> `LoginScreen`
- `/signup` -> `SignupScreen`
- `/home` -> `HomeScreen`
- `/menu` -> `MenuScreen`
- `/item/:id` -> `ItemDetailsScreen`
- `/search` -> `SearchScreen`
- `/favorites` -> `FavoritesScreen`
- `/cart` -> `CartScreen`
- `/checkout` -> `CheckoutScreen`
- `/orders` -> `OrdersScreen`
- `/orders/confirmation/:id` -> `OrderSuccessScreen`
- `/orders/tracking/:id` -> `OrderTrackingScreen`
- `/profile` -> `ProfileScreen`
- `/loyalty` -> `LoyaltyScreen`
- `/offers` -> `OffersScreen`

### Admin Panel Routes (10 Routes wrapped in `AdminShell`)
- `/admin/dashboard` -> `AdminDashboardScreen`
- `/admin/orders` -> `OrderManagementScreen`
- `/admin/menu` -> `MenuManagementScreen`
- `/admin/menu/add` -> `AdminFoodFormScreen`
- `/admin/menu/edit` -> `AdminFoodFormScreen`
- `/admin/menu/add-category` -> `AdminCategoryFormScreen`
- `/admin/menu/edit-category` -> `AdminCategoryFormScreen`
- `/admin/offers` -> `OffersManagementScreen`
- `/admin/offers/add` -> `AdminPromoFormScreen`
- `/admin/notifications` -> `AdminNotificationsScreen`
- `/admin/settings` -> `AdminSettingsScreen`

---

## 11. FIREBASE & FCM STATUS

- **Firebase Project ID:** `keebda-zaman`
- **Android Package Name:** `com.example.kebda_zaman`
- **Configuration Files Present:**
  - `android/app/google-services.json` (Valid)
  - `lib/firebase_options.dart` (Officially generated via `flutterfire configure`)
- **Platforms Supported:** Android, Web, iOS, macOS, Windows.
- **Initialization Status:** Fully initialized via `Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform)` inside `main.dart` and `NotificationService`.
- **FCM Token Handling:** Retrievable via `NotificationService.instance.getFcmToken()`. Contains `syncTokenWithBackend(String token)` marked with `TODO: POST /devices/register`.
- **Foreground Display:** Enabled via `flutter_local_notifications` high importance channel (`kebda_zaman_high_importance_channel`).

---

## 12. NOTIFICATION SYSTEM STATUS

- **Payload Architecture (`AppNotificationPayload`):** Parses raw FCM `data` map safely. Supports 14 types: `general`, `promotion`, `offer`, `new_product`, `category`, `order_created`, `order_confirmed`, `order_preparing`, `order_ready`, `order_out_for_delivery`, `order_delivered`, `order_cancelled`, `payment_success`, `payment_failed`.
- **Admin Notification Composer:** Integrated at `/admin/notifications` with live mobile preview card, dynamic deep-link destination dropdown, schedule date/time pickers, and campaign performance table.
- **Backend Technical Documentation:** Complete specification written in `docs/future_backend_contract.md`.

---

## 13. AUTHENTICATION STATUS

- **Current Implementation:** Local `SharedPreferences` session storage managed by `AuthNotifier`. Supports Customer Registration, Login, and Guest mode.
- **Security Audit:** Passwords are currently validated locally in mock repositories.
- **Required Backend Auth API Endpoints:**
  - `POST /api/v1/auth/register`
  - `POST /api/v1/auth/login`
  - `POST /api/v1/auth/logout`
  - `POST /api/v1/auth/refresh-token`
  - `GET /api/v1/auth/me`

---

## 14. CART & CHECKOUT AUDIT

- **State Management:** `CartNotifier` maintains items list and calculates financials.
- **Frontend Financial Calculations:**
  - `subtotal` = Sum of (`unitPrice` * `quantity`) for all cart items.
  - `discount` = Percentage or Fixed discount calculated from `appliedPromo`.
  - `tax` = `(subtotal - discount) * taxRate`.
  - `total` = `subtotal - discount + deliveryFee + tax`.
- **CRITICAL SECURITY REQUIREMENT FOR BACKEND:** All calculations (subtotal, promo code validity, tax %, delivery fee, total amount) are currently computed on the client side. When the backend is built, **the backend MUST recalculate and validate all prices server-side** before creating an order to prevent price tampering.

---

## 15. ORDER SYSTEM AUDIT

- **Order Status Lifecycle:** `pending` -> `confirmed` -> `preparing` -> `outForDelivery` -> `delivered` (or `cancelled`).
- **Tracking Screen:** `OrderTrackingScreen` renders a step-by-step progress bar and estimated delivery time.
- **Admin Status Override:** `OrderManagementScreen` allows admins to change order status via an interactive dropdown.
- **Required Backend Order Endpoints:**
  - `POST /api/v1/orders` (Create Order)
  - `GET /api/v1/orders` (List User Orders)
  - `GET /api/v1/orders/:id` (Order Details & Tracking)
  - `PATCH /api/v1/admin/orders/:id/status` (Update Status)

---

## 16. PAYMENT SYSTEM STATUS

- **Current Options Shown:**
  1. Cash on Delivery (COD)
  2. Credit / Debit Card (Visa / Mastercard placeholder)
  3. Mobile Wallet (Vodafone Cash / Orange Money placeholder)
- **Current Service:** `FakePaymentService` returns `Success(PaymentResult)` after a 1.2s delay.
- **Future Backend Gateway Requirements:**
  - Payment gateway API integration (Paymob / Fawry / Stripe).
  - Secure Webhook endpoint `POST /api/v1/payments/webhook` to handle asynchronous payment success/failure callbacks.

---

## 17. BACKEND REQUIREMENTS MATRIX

| Frontend Feature | Current Data Source | Required Backend Module | Required API Endpoint | Proposed Database Entity | Priority |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Authentication** | `SharedPreferences` / Fake Auth | Auth Module | `POST /api/v1/auth/login` | `User` | **P0** |
| **User Registration** | Fake Auth | Auth Module | `POST /api/v1/auth/register` | `User` | **P0** |
| **Food Menu Catalog** | `FakeMenuRepository` | Catalog Module | `GET /api/v1/menu` | `Category`, `MenuItem`, `ItemVariant`, `Addon` | **P0** |
| **Category List** | `FakeMenuRepository` | Catalog Module | `GET /api/v1/categories` | `Category` | **P0** |
| **Cart Operations** | `FakeCartRepository` | Cart Module | `GET /api/v1/cart`, `POST /api/v1/cart/items` | `Cart`, `CartItem` | **P0** |
| **Order Placement** | `FakeOrderRepository` | Order Module | `POST /api/v1/orders` | `Order`, `OrderItem` | **P0** |
| **Order Tracking** | `FakeOrderRepository` | Order Module | `GET /api/v1/orders/:id/tracking` | `Order` | **P0** |
| **FCM Device Registration** | Local Log | Device Module | `POST /api/v1/devices/register` | `DeviceToken` | **P0** |
| **Admin Order Management** | `FakeOrderRepository` | Admin Order Module | `PATCH /api/v1/admin/orders/:id/status` | `Order` | **P0** |
| **Admin Campaign Dispatch** | `FakeAdminNotificationRepository` | Notification Campaign Module | `POST /api/v1/admin/notifications/send` | `NotificationCampaign` | **P1** |
| **Promo Code Validation** | `FakePromoRepository` | Promotion Module | `POST /api/v1/promos/validate` | `PromoCode` | **P1** |
| **User Profile Management** | `SharedPreferences` | User Profile Module | `PUT /api/v1/user/profile` | `User`, `Address` | **P1** |
| **Loyalty Rewards** | `FakeLoyaltyRepository` | Loyalty Module | `GET /api/v1/user/loyalty` | `LoyaltyAccount` | **P2** |
| **Restaurant Settings** | `FakeSettingsRepository` | Settings Module | `GET /api/v1/settings` | `RestaurantSettings` | **P2** |

---

## 18. PROPOSED API INVENTORY

### Authentication & Users
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/user/profile`
- `PUT /api/v1/user/profile`
- `GET /api/v1/user/addresses`
- `POST /api/v1/user/addresses`

### Menu Catalog & Categories
- `GET /api/v1/categories`
- `GET /api/v1/menu`
- `GET /api/v1/menu/items/:id`
- `GET /api/v1/menu/search?q=`

### Cart & Checkout
- `GET /api/v1/cart`
- `POST /api/v1/cart/items`
- `PUT /api/v1/cart/items/:id`
- `DELETE /api/v1/cart/items/:id`
- `POST /api/v1/cart/apply-promo`

### Orders & Tracking
- `POST /api/v1/orders`
- `GET /api/v1/orders`
- `GET /api/v1/orders/:id`
- `GET /api/v1/orders/:id/tracking`

### Devices & Push Notifications
- `POST /api/v1/devices/register`
- `DELETE /api/v1/devices/unregister`

### Admin Management APIs
- `GET /api/v1/admin/dashboard/stats`
- `GET /api/v1/admin/orders`
- `PATCH /api/v1/admin/orders/:id/status`
- `POST /api/v1/admin/menu/items`
- `PUT /api/v1/admin/menu/items/:id`
- `DELETE /api/v1/admin/menu/items/:id`
- `POST /api/v1/admin/notifications/send`
- `POST /api/v1/admin/notifications/schedule`
- `GET /api/v1/admin/notifications/campaigns`

---

## 19. PROPOSED DATABASE ENTITY INVENTORY

### Entity 1: `User`
- **Fields:** `id` (UUID, Primary Key), `email` (String, Unique), `passwordHash` (String), `fullName` (String), `phone` (String), `role` (Enum: `CUSTOMER`, `ADMIN`), `createdAt` (Timestamp).
- **Relations:** Has many `Address`, Has many `Order`, Has many `DeviceToken`.

### Entity 2: `Address`
- **Fields:** `id` (UUID), `userId` (FK -> User), `title` (String), `street` (String), `building` (String), `floor` (String?), `apartment` (String?), `city` (String), `isDefault` (Boolean).

### Entity 3: `Category`
- **Fields:** `id` (UUID), `nameAr` (String), `nameEn` (String), `iconUrl` (String?), `displayOrder` (Int), `isActive` (Boolean).

### Entity 4: `MenuItem`
- **Fields:** `id` (UUID), `categoryId` (FK -> Category), `nameAr` (String), `nameEn` (String), `descriptionAr` (Text), `descriptionEn` (Text), `basePrice` (Decimal), `imageUrl` (String), `isAvailable` (Boolean), `isPopular` (Boolean).
- **Relations:** Has many `ItemVariant`, Has many `AddonGroup`.

### Entity 5: `Order`
- **Fields:** `id` (UUID), `orderNumber` (String, Unique), `userId` (FK -> User), `status` (Enum: `PENDING`, `CONFIRMED`, `PREPARING`, `OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELLED`), `subtotal` (Decimal), `deliveryFee` (Decimal), `tax` (Decimal), `discount` (Decimal), `totalAmount` (Decimal), `paymentMethod` (Enum: `CASH`, `CARD`, `WALLET`), `paymentStatus` (Enum: `PENDING`, `PAID`, `FAILED`), `deliveryAddressJson` (JSONB), `createdAt` (Timestamp).

### Entity 6: `NotificationCampaign`
- **Fields:** `id` (UUID), `campaignName` (String), `title` (String), `body` (String), `imageUrl` (String?), `type` (String), `targetAudience` (String), `destinationRoute` (String?), `status` (Enum: `DRAFT`, `SCHEDULED`, `SENDING`, `SENT`, `FAILED`), `scheduledAt` (Timestamp?), `sentAt` (Timestamp?), `totalRecipients` (Int), `deliveredCount` (Int), `openedCount` (Int).

---

## 20. RISKS & CONFLICTS AUDIT

1. **Frontend Price Security Risk:**
   - **Risk:** `CartNotifier` and `CheckoutScreen` currently compute prices, taxes, and promo discounts entirely on the client side.
   - **Impact:** Malicious users could alter HTTP payloads if the future backend blindly accepts client-side total amounts.
   - **Mitigation Requirement:** The future backend service must recalculate item unit prices, variant premiums, add-on prices, discounts, tax, and total amount from the database before persisting an order.

2. **Web Local Storage vs. Mobile Shared Preferences:**
   - **Risk:** Admin panel running on Web uses browser `SharedPreferences` wrapper.
   - **Mitigation Requirement:** Admin authentication must use secure HTTP-only cookies or JWT tokens stored securely.

3. **Missing Real-Time Websocket Connection for Tracking:**
   - **Risk:** `OrderTrackingScreen` currently uses local timers to simulate driver movement.
   - **Mitigation Requirement:** Integrate WebSockets or Server-Sent Events (SSE) when building the backend.

---

## 21. SAFE BACKEND MIGRATION PLAN

```text
Phase 1: Backend Architecture Setup & Database Schema Migration
  └─ Setup Node.js / NestJS server, PostgreSQL / MongoDB database, and Prisma ORM schemas.

Phase 2: Authentication & User Accounts API Integration
  └─ Deploy /auth/register, /auth/login, /user/profile endpoints.
  └─ Swap FakeAuthRepository in Flutter app with ApiAuthRepository without breaking UI.

Phase 3: Catalog & Categories API Integration
  └─ Deploy /categories and /menu endpoints.
  └─ Swap FakeMenuRepository with ApiMenuRepository.

Phase 4: Cart & Order Checkout Pipeline Integration
  └─ Deploy /orders endpoint with server-side price recalculation & validation.
  └─ Swap FakeOrderRepository with ApiOrderRepository.

Phase 5: FCM Device Token Registration Integration
  └─ Deploy /devices/register endpoint.
  └─ Activate syncTokenWithBackend(token) in NotificationService.

Phase 6: Admin Panel API Integration
  └─ Connect Admin Dashboard, Order Board, and Notification Campaign Composer to backend API.

Phase 7: Final Mock Data Removal
  └─ Delete fake repository implementations only after 100% API validation.
```

---

## 22. FINAL CURRENT STATE SUMMARY

- **What Currently Works:**
  - 100% of Flutter customer screens (19 screens) and Admin Panel management views (10 views) are fully functional, responsive, and styled with `KZ` design system tokens.
  - Complete multilingual support (Arabic & English) with dynamic runtime switching.
  - Complete Push Notification architecture (FCM, `flutter_local_notifications`, deep-link navigation, live mobile preview in Admin Panel).
  - Firebase initialized using official `google-services.json` and `firebase_options.dart` for project `keebda-zaman`.

- **What is Frontend-Only / Mocked:**
  - All data queries and mutations run against local fake repositories (`FakeMenuRepository`, `FakeOrderRepository`, `FakeCartRepository`, `FakeAuthRepository`, `FakePromoRepository`, `FakeLoyaltyRepository`, `FakeSettingsRepository`, `FakeAdminNotificationRepository`).
  - User auth sessions are stored in local `SharedPreferences`.

- **What Needs to Be Built Next (Backend Phase):**
  - REST API backend service & Database schema (PostgreSQL / MongoDB).
  - Server-side order price calculation and security validation.
  - Backend FCM campaign dispatch via Firebase Admin SDK.

- **What MUST NOT Be Changed Yet:**
  - Do NOT remove or delete any fake repository files until API endpoints are built and tested.
  - Do NOT alter existing GoRouter route names or `AppNotificationPayload` parsing rules.
